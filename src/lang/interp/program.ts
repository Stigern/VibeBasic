// Public API of the interpreter (Program) and its shared state (Runtime).

import type { ProcDecl, Stmt, TypeDecl, VBTypeName } from '../ast';
import { VBRuntimeError, VBSyntaxError, internalError } from '../errors';
import { compileProblems } from '../compileCheck';
import { ErrObject, type BuiltinCtx } from '../builtins';
import type { CodeLocation, Host } from '../host';
import { generalDateText, localeDateParser } from '../builtins/format';
import { newRndState } from '../builtins/util';
import { FileIO } from '../fileio/fileIO';
import { parseModule } from '../parser';
import { parseCondConsts, type CondConsts } from '../condComp';
import {
  Empty, NothingT, RefContainer, VBArray, VBRecord, VBRef, defaultValue, dropValue, isObject, refCounting, setDateTextFormatter, setDateTextParser, toNumber, type DateTextFormatter,
  type DateTextParser, type VBValue,
} from '../values';
import { EndSignal, SubCall, runGenerator, runSync, type ExecScope, type Gen } from './driver';
import { constExpr } from './eval';
import { RETRY, declareVariable, handleError, invokeProc, isStackOverflow, newVariable, reap, type BoundArg } from './exec';
import { ProgramDebugger } from './debugger';
import { runImmediate } from './immediate';
import { snapshotVariables } from './snapshot';

/**
 * Event handlers nested in each other (an event fired while another handler
 * waits or sets a property) beyond this depth are error 28, Out of stack
 * space. Synchronously fired events nest on the JS stack, so this stays well
 * below what the JS engine allows.
 */
export const MAX_EVENT_NESTING = 100;
import {
  ClassInstance, Frame, GlobalScope, ModuleScope, ProcRef, Run, Variable, fitFixed, lc, rawValue, startCounting, type FieldInfo, type TypeInfo,
} from './scope';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** `kind` 'class': a class module (`New Name` makes an object of it). */
export interface SourceModule { name: string; kind: 'form' | 'module' | 'class'; source: string }
export interface ProgramOptions {
  /**
   * Statements between clock checks (default 1000). Without `sliceMs` an
   * explicit sliceSize yields at every check (count-based slices, tests).
   */
  sliceSize?: number;
  /** A time slice is taken when this many ms have passed since the last one (default 16; 0 when sliceSize is given). */
  sliceMs?: number;
  locale?: string;
  /** Default MsgBox/InputBox title (default 'Project1'). */
  appTitle?: string;
  /** App.Path: where CurDir starts (default '/'). */
  appPath?: string;
  /** The project's conditional compilation arguments for `#If` (`DEBUG = 1 : BETA = 0`, see condComp.ts). */
  condComp?: string;
  /** A made app: `Debug.Assert` does nothing (the IDE breaks when its condition is False). */
  ignoreAsserts?: boolean;
}

export type ProgramState = 'idle' | 'running' | 'break' | 'ended';

/** Shared interpreter state: modules, globals, flags. Internal; `Program` is the public face. */
export class Runtime {
  state: ProgramState = 'idle';
  /** Set when the program ends; running code stops at the next statement boundary. */
  stopping = false;
  /** Set by requestPause (or a breakpoint line); the next statement boundary enters break mode. */
  pauseRequested = false;
  /** Procedures running, over all runs (nested event handlers on top of the one they interrupted). */
  callDepth = 0;
  /** Stepping: a statement breaks when `callDepth <= stepDepth` (Infinity: Step Into; -1: not stepping). */
  stepDepth = -1;
  /** Breakpoint lines per module key (set by the IDE). */
  private readonly userBreakpoints = new Map<string, Set<number>>();
  /** The one-shot line of Run To Cursor. */
  private runTo?: { key: string; line: number };
  /** Statements since the last time slice. */
  stmtCount = 0;
  /** Column of an unfinished Debug.Print line (after a trailing `;` or `,`). */
  printColumn = 0;
  /** Event handlers currently running (nested ones count too). */
  activeRuns = 0;
  /** Immediate commands currently running (a pause request then has nothing to break into). */
  immediateRuns = 0;
  /** The runs behind `activeRuns`, each with its call stack (for End and break mode). */
  readonly runs = new Set<Run>();
  /** The frame that is stopped in break mode (the Immediate window evaluates there). */
  breakFrame?: Frame;
  /** Break watches (debugger.ts), asked at every statement boundary; null (the hot path skips it) when there are none. */
  watchHook: ((f: Frame) => Gen<boolean>) | null = null;
  /** Set Next Statement, chosen in break mode: the statement of the break frame that runs next. */
  nextJump?: { frame: Frame; stmt: Stmt };
  /** Runs currently waiting in a time slice (`nextTick`); events arriving meanwhile are queued. */
  slicing = 0;
  /** Events that arrived during a time slice, started at the next event pump or when the run finishes. */
  private readonly eventQueue: (() => void)[] = [];
  private runSeq = 0;
  /** Waits for nested runs (`nestedRuns`) that the end of the program must release; each removes itself when done. */
  readonly endWaiters = new Set<() => void>();
  /**
   * > 0 while an unhandled error is being reported or onBreak is pending:
   * no event pump (queued events stay queued), new events are dropped.
   */
  eventsSuspended = 0;
  /** VB's `Err` object (also `builtinCtx.err`). */
  readonly err: ErrObject;
  /**
   * Cancel listeners of the waits in progress (`cancellable`): each rejects
   * its wait with an EndSignal when the program ends, and removes itself when
   * the wait settles, so a long DoEvents loop does not accumulate them.
   */
  readonly abortListeners = new Set<(e: EndSignal) => void>();
  /** Set when an event was refused for nesting too deep; the running statement raises error 28. */
  overflow = false;
  readonly sliceSize: number;
  readonly sliceMs: number;
  /** performance.now() of the last time slice (or of the start of the current run). */
  lastSlice = 0;
  readonly locale: string;
  readonly builtinCtx: BuiltinCtx;
  /** Open, Close, Print # ... and CurDir. */
  readonly files: FileIO;
  /** Resolves once the files open at the end are written and closed (a made app quits only then). */
  filesClosed: Promise<void> = Promise.resolve();
  /** Makes this program's locale (date text and parsing) current while its code runs; pass to `runGenerator`. */
  readonly scope: ExecScope;
  private readonly dateText: DateTextFormatter;
  /** Reads this program's locale date text back (CDate, IsDate); current with `dateText`. */
  private readonly dateParse: DateTextParser;
  readonly modules = new Map<string, ModuleScope>();
  readonly moduleList: ModuleScope[] = [];
  readonly globals = new GlobalScope();
  private readonly statics = new Map<ProcDecl, Map<string, Variable>>();
  private readonly declRun: Run;
  private readonly declFrames = new Map<ModuleScope, Frame>();
  private readonly resolvedTypes = new WeakMap<object, VBTypeName>();
  private readonly typeInfos = new Map<string, TypeInfo>();
  private initialized = false;
  /** Class modules by lower-case name. */
  readonly classes = new Map<string, ModuleScope>();
  /** Objects of class modules that have not terminated, in the order they were made. */
  readonly instances = new Set<ClassInstance>();
  /** `Debug.Assert` is skipped (a made app). */
  readonly ignoreAsserts: boolean;
  /**
   * Objects whose last counted reference went away, with the call depth at that moment: a statement at that depth or
   * shallower terminates them when it ends (exec.ts `reap`), unless they were stored again meanwhile.
   */
  dying: { inst: ClassInstance | RefContainer; depth: number }[] | null = null;
  /** Where this program's Collections and Dictionaries without references wait (refCounting.sink while its code runs). */
  private readonly sink = (c: RefContainer): void => this.queueDying(c);

  constructor(sources: SourceModule[], readonly host: Host, opts: ProgramOptions = {}) {
    this.sliceSize = Math.max(1, opts.sliceSize ?? 1000);
    this.sliceMs = Math.max(0, opts.sliceMs ?? (opts.sliceSize !== undefined ? 0 : 16));
    this.locale = opts.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
    const appTitle = opts.appTitle ?? 'Project1';
    this.err = new ErrObject(appTitle);
    this.files = new FileIO(() => host.fileSystem?.(), opts.appPath ?? '/', this);
    this.builtinCtx = { host, locale: this.locale, appTitle, rnd: newRndState(), err: this.err, files: this.files };
    this.dateText = v => generalDateText(v.serial, this.locale);
    this.dateParse = localeDateParser(this.locale);
    this.scope = {
      activate: () => {
        const prev = setDateTextFormatter(this.dateText);
        const prevParse = setDateTextParser(this.dateParse);
        const prevSink = refCounting.sink;
        refCounting.sink = this.sink;
        return () => {
          setDateTextFormatter(prev);
          setDateTextParser(prevParse);
          refCounting.sink = prevSink;
        };
      },
      cancellable: p => this.cancellable(p),
    };
    this.declRun = new Run(this);
    this.ignoreAsserts = opts.ignoreAsserts === true;
    let consts: CondConsts | undefined;
    try {
      consts = opts.condComp ? parseCondConsts(opts.condComp) : undefined;
    } catch (e) {
      if (e instanceof VBSyntaxError) throw new VBSyntaxError(`Conditional compilation arguments: ${e.message}`, 1, 1);
      throw e;
    }
    for (const src of sources) {
      const m = new ModuleScope(src.name, src.kind, parseModule(src.source, src.name, consts));
      this.modules.set(m.key, m);
      this.moduleList.push(m);
      if (m.kind === 'module') this.globals.addModule(m);
      else if (m.kind === 'class' && !this.classes.has(m.key)) this.classes.set(m.key, m);
    }
    // objects of class modules can end (Class_Terminate): count references from the start, also in the Collections made first
    if (this.classes.size > 0) startCounting();
    // the compile errors VB6 finds before the program starts (a ByRef type mismatch, New of a record ...)
    const problem = compileProblems(this.moduleList.map(m => ({ name: m.name, kind: m.kind, ast: m.ast })))[0];
    if (problem) {
      const e = new VBSyntaxError(problem.message, problem.line, 1);
      e.moduleName = problem.module;
      throw e;
    }
  }

  /** A frame for evaluating a module's declarations (constants, module-level Dim bounds). */
  moduleFrame(m: ModuleScope): Frame {
    let f = this.declFrames.get(m);
    if (!f) {
      f = new Frame(this.declRun, m, null, 0);
      this.declFrames.set(m, f);
    }
    return f;
  }

  staticStore(p: ProcDecl): Map<string, Variable> {
    let s = this.statics.get(p);
    if (!s) {
      s = new Map();
      this.statics.set(p, s);
    }
    return s;
  }

  // ---- types ----

  private findType(name: string, m: ModuleScope): { decl: TypeDecl; module: ModuleScope } | undefined {
    const key = lc(name);
    const own = m.types.get(key);
    if (own) return { decl: own, module: m };
    const pub = this.globals.types.get(key);
    if (pub) return pub;
    for (const other of this.moduleList) {
      const t = other.types.get(key);
      if (t) return { decl: t, module: other };
    }
    return undefined;
  }

  /**
   * A declared type as the interpreter uses it: undefined → Variant; a name
   * the parser could not resolve (`{objectType}`) becomes the user type or
   * enum (Long) of that name from any module.
   */
  resolveType(t: VBTypeName | undefined, m: ModuleScope): VBTypeName {
    if (t === undefined) return 'Variant';
    if (typeof t === 'string') return t;
    const cached = this.resolvedTypes.get(t);
    if (cached) return cached;
    let r: VBTypeName = t;
    const name = 'userType' in t ? t.userType : t.objectType;
    const found = this.findType(name, m);
    if (found) r = { userType: found.decl.name };
    else if ('objectType' in t) {
      const key = lc(name);
      if (m.enums.has(key) || this.globals.enums.has(key) || this.moduleList.some(o => o.enums.has(key))) r = 'Long';
      // an enum of a type library (ADODB.EventReasonEnum, MSComctlLib.ListLabelEditConstants): a Long
      else if (/\.\w*(enum|constants)$/i.test(name)) r = 'Long';
      // a class module of the project (`As Thing`, `As Project1.Thing`)
      else if (this.classes.has(lc(name.slice(name.lastIndexOf('.') + 1)))) r = { objectType: name, classModule: true };
    } else throw VBRuntimeError.compile('User-defined type not defined');
    this.resolvedTypes.set(t, r);
    return r;
  }

  typeInfo(name: string): TypeInfo {
    const key = lc(name);
    let info = this.typeInfos.get(key);
    if (info) return info;
    let found: { decl: TypeDecl; module: ModuleScope } | undefined = this.globals.types.get(key);
    if (!found) {
      for (const m of this.moduleList) {
        const t = m.types.get(key);
        if (t) { found = { decl: t, module: m }; break; }
      }
    }
    if (!found) throw VBRuntimeError.compile('User-defined type not defined');
    const fields = new Map<string, FieldInfo>();
    const frame = this.moduleFrame(found.module);
    for (const d of found.decl.fields) {
      const fi: FieldInfo = {
        name: d.name,
        type: this.resolveType(d.type, found.module),
        fixedLength: d.fixedLength,
        isArray: d.isArray,
      };
      if (d.bounds) {
        fi.bounds = d.bounds.map(b => [
          b.lower ? toNumber(constExpr(frame, b.lower)) : found.module.optionBase,
          toNumber(constExpr(frame, b.upper)),
        ]);
      }
      fields.set(lc(d.name), fi);
    }
    info = { decl: found.decl, module: found.module, fields };
    this.typeInfos.set(key, info);
    return info;
  }

  /** A new record of a user type with every field at its default. */
  newRecord(typeName: string): VBRecord {
    const info = this.typeInfo(typeName);
    const fields = new Map<string, VBValue>();
    for (const [k, fi] of info.fields) {
      if (fi.isArray && fi.fixedLength !== undefined) fields.set(k, VBArray.fixedString(fi.bounds ?? null, fi.fixedLength, !!fi.bounds));
      else if (fi.isArray) fields.set(k, fi.bounds ? this.newArray(fi.type, fi.bounds, true) : this.unallocatedArray(fi.type));
      else fields.set(k, this.defaultFor(fi.type, fi.fixedLength));
    }
    return new VBRecord(info.decl.name, fields);
  }

  private elementInit(t: VBTypeName): (() => VBValue) | undefined {
    if (typeof t === 'object' && 'userType' in t) {
      const name = t.userType;
      return () => this.newRecord(name);
    }
    return undefined;
  }

  /** `init` makes each element (`Dim a(3) As New Collection`); by default the type's default value. */
  newArray(t: VBTypeName, bounds: [number, number][], fixed: boolean, init?: () => VBValue): VBArray {
    return new VBArray(t, bounds, fixed, init ?? this.elementInit(t)).own();
  }

  unallocatedArray(t: VBTypeName, init?: () => VBValue): VBArray {
    return VBArray.unallocated(t, init ?? this.elementInit(t)).own();
  }

  /** Initial value of a variable of type `t` (`String * n` starts as n spaces). */
  defaultFor(t: VBTypeName, fixedLength?: number): VBValue {
    if (typeof t === 'object' && 'userType' in t) return this.newRecord(t.userType);
    if (fixedLength !== undefined) return fitFixed('', fixedLength);
    return defaultValue(t);
  }

  // ---- objects of class modules ----

  /** A new object of a class module: its own module-level variables; Class_Initialize runs later (eval.ts `ready`). */
  newInstance(m: ModuleScope): ClassInstance {
    const inst = new ClassInstance(this, m);
    const frame = this.moduleFrame(m);
    for (const d of m.ast.variables) {
      const v = newVariable(frame, d, d.isArray && d.bounds ? d.bounds.map(b => [
        b.lower ? toNumber(constExpr(frame, b.lower)) : m.optionBase, toNumber(constExpr(frame, b.upper)),
      ] as [number, number]) : null);
      if (d.withEvents) v.opts.events = { module: m, instance: inst };
      inst.vars.set(lc(d.name), v);
    }
    this.instances.add(inst);
    return inst;
  }

  /**
   * `inst` has no counted reference left: it terminates at the end of the statement (see `dying`); a Collection or
   * Dictionary lets go of its items then.
   */
  queueDying(inst: ClassInstance | RefContainer): void {
    (this.dying ??= []).push({ inst, depth: this.callDepth });
  }

  /** The object is gone (Class_Terminate has run or is about to): its variables let go of what they hold. */
  dropInstance(inst: ClassInstance): void {
    inst.dead = true;
    this.instances.delete(inst);
    for (const v of inst.vars.values()) {
      const x = rawValue(v.ref);
      if (v.opts.events && x instanceof ClassInstance) x.sinks?.delete(v);
      if (!v.opts.isConst) dropValue(x);
    }
  }

  // ---- lifecycle ----

  /**
   * Ends the program once (End, Program.end, an unhandled error answered
   * 'end'): state 'ended'; every run stops — code at its next statement
   * boundary, waits (host promises, onBreak, onRuntimeError, nested runs)
   * at once through `cancellable`; queued events are released without running;
   * host.onEnd() is called.
   */
  endProgram(): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.stopping = true;
    this.pauseRequested = false;
    this.breakFrame = undefined;
    const waiters = [...this.endWaiters];
    this.endWaiters.clear();
    for (const w of waiters) w();
    const cancels = [...this.abortListeners];
    this.abortListeners.clear();
    for (const cancel of cancels) cancel(new EndSignal());
    this.drainEvents(); // each queued runEvent sees 'ended' and resolves
    this.filesClosed = this.files.closeAll().catch(() => {}); // buffered Print # text is written, every file closed
    try {
      this.host.onEnd();
    } catch (e) {
      console.error('VibeBasic: onEnd failed', e);
    }
  }

  /**
   * Break mode with no code running (requestPause while idle): host.onBreak
   * with an empty location; state 'break' until it answers ('end' ends the
   * program, 'continue' or a rejected onBreak goes back to 'idle').
   */
  /** Ends a step and a Run To Cursor (any break does). */
  stopDebugging(): void {
    this.stepDepth = -1;
    if (this.runTo) {
      const key = this.runTo.key;
      this.runTo = undefined;
      this.syncBreakpoints(key);
    }
  }

  setBreakpoints(moduleName: string, lines: Iterable<number>): void {
    const key = lc(moduleName);
    const set = new Set(lines);
    if (set.size) this.userBreakpoints.set(key, set);
    else this.userBreakpoints.delete(key);
    this.syncBreakpoints(key);
  }

  setRunTo(moduleName: string, line: number): void {
    const old = this.runTo?.key;
    this.runTo = { key: lc(moduleName), line };
    if (old !== undefined && old !== this.runTo.key) this.syncBreakpoints(old);
    this.syncBreakpoints(this.runTo.key);
  }

  /** The module's effective break lines: its breakpoints and the Run To Cursor line. */
  private syncBreakpoints(key: string): void {
    const m = this.modules.get(key);
    if (!m) return;
    const set = new Set(this.userBreakpoints.get(key));
    if (this.runTo?.key === key) set.add(this.runTo.line);
    for (const x of this.moduleList) if (x === m || lc(x.sourceName) === key) x.breakpoints = set.size ? set : null;   // its form instances too
  }

  pauseIdle(): void {
    this.pauseRequested = false;
    this.stopDebugging();
    this.state = 'break';
    this.eventsSuspended++;
    const info = { reason: 'pause' as const, at: { moduleName: '', procName: '', line: 0 } };
    let asked: Promise<'continue' | 'end'>;
    try {
      asked = Promise.resolve(this.host.onBreak(info));
    } catch (e) {
      asked = Promise.reject(e);
    }
    void this.untilEnd(asked)
      .catch(() => 'continue' as const)
      .then(answer => {
        this.eventsSuspended--;
        if (this.state !== 'break') return; // ended meanwhile
        if (answer === 'end') this.endProgram();
        else this.state = 'idle';
      });
  }

  /**
   * `p`, but rejected with an EndSignal as soon as the program ends (at once
   * when it already has). The cancel listener lives only until `p` settles.
   */
  cancellable<T>(p: Promise<T>): Promise<T> {
    if (this.stopping) {
      p.catch(() => {});
      return Promise.reject(new EndSignal());
    }
    return new Promise<T>((resolve, reject) => {
      const cancel = (e: EndSignal) => reject(e);
      this.abortListeners.add(cancel);
      p.then(
        v => { this.abortListeners.delete(cancel); resolve(v); },
        e => { this.abortListeners.delete(cancel); reject(e); },
      );
    });
  }

  /** `p`, or undefined as soon as the program ends (for awaits outside the driver). */
  untilEnd<T>(p: Promise<T>): Promise<T | undefined> {
    return this.cancellable(p).catch(e => {
      if (e instanceof EndSignal) return undefined;
      throw e;
    });
  }

  // ---- event runs (re-entrancy) ----
  //
  // VB6 runs one handler at a time on one stack. A handler that waits in a
  // host promise (DoEvents, a dialog, an async method such as a modal Show)
  // pumps events: handlers started meanwhile run nested, and the waiting
  // handler resumes only after they have all finished (`nestedRuns`, used by
  // the driver after every await and by `afterHostCall` after synchronous host
  // calls that may fire events). A time slice (`nextTick` while a long loop
  // runs) is not a pump: events arriving then are queued and start at the
  // next pump or when the busy handler finishes, as VB6 would process them
  // after the handler (or at its next DoEvents).

  /** At a clock check (`sliceSize` statements): true when a time slice is due; resets the count either way. */
  sliceDue(): boolean {
    this.stmtCount = 0;
    return this.sliceMs <= 0 || now() - this.lastSlice >= this.sliceMs;
  }

  /** A time slice just ended. */
  sliced(): void { this.lastSlice = now(); }

  /** Registers an event run: start order and a promise that resolves when it finishes. */
  beginRun(run: Run): () => void {
    if (this.activeRuns === 0) this.lastSlice = now();   // an idle program starts a fresh slice
    let finish!: () => void;
    run.seq = ++this.runSeq;
    run.done = new Promise<void>(r => { finish = r; });
    this.activeRuns++;
    this.runs.add(run);
    return () => {
      this.runs.delete(run);
      this.activeRuns--;
      if (this.activeRuns === 0 && this.state === 'running') {
        this.state = 'idle';
        // a pause requested while the last handler was waiting (no boundary reached): break now, idle
        if (this.pauseRequested) this.pauseIdle();
      }
      if (this.slicing === 0) this.drainEvents();
      finish();
    };
  }

  /** Waits for event runs started after `run` (nested handlers); undefined when there are none or the program is stopping. */
  nestedRuns(run: Run): Promise<void> | undefined {
    if (this.stopping || run.seq === 0) return undefined;
    let later: Promise<void>[] | undefined;
    for (const r of this.runs) {
      if (r.seq > run.seq) (later ??= []).push(r.done!);
    }
    if (!later) return undefined;
    const nested = later;
    return new Promise<void>(resolve => {
      const done = () => {
        this.endWaiters.delete(done);
        resolve();
      };
      this.endWaiters.add(done);
      void Promise.all(nested).then(done);
    });
  }

  /** False in break mode, after the end, and while an error is reported: an event arriving now is dropped. */
  get acceptsEvents(): boolean {
    return this.state !== 'ended' && this.state !== 'break' && this.eventsSuspended === 0;
  }

  /** True when an event arriving now must be queued (a run is in a time slice). */
  get busy(): boolean { return this.slicing > 0; }

  /** Queues an event start for later (see `drainEvents`). */
  queueEvent(start: () => void): void {
    this.eventQueue.push(start);
  }

  /** Starts the queued events (an event pump). */
  drainEvents(): void {
    if (this.eventQueue.length === 0) return;
    const queued = this.eventQueue.splice(0);
    for (const start of queued) start();
  }

  /** The driver scope of an event run: locale, event pump before awaits, nested runs after, End. */
  runScope(run: Run): ExecScope {
    return {
      activate: this.scope.activate,
      // no pump in a time slice, while an error is reported or in break mode
      beforeAwait: () => { if (this.slicing === 0 && this.eventsSuspended === 0) this.drainEvents(); },
      afterAwait: () => this.nestedRuns(run),
      cancellable: this.scope.cancellable,
    };
  }

  /** Creates module-level variables (once, before the first event runs). */
  *ensureInit(run: Run): Gen<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const m of this.moduleList) {
      if (m.kind === 'class') { m.initialized = true; continue; }   // each object has its own variables
      yield* this.initModule(run, m);
    }
  }

  /** Another instance of form module `source` (New Form1), under the key `name`; its variables are made before its first event. */
  addFormInstance(source: string, name: string): void {
    const src = this.modules.get(lc(source));
    if (!src || src.kind !== 'form' || this.modules.has(lc(name))) return;
    const m = new ModuleScope(name, 'form', src.ast, src.sourceName);
    m.breakpoints = src.breakpoints;
    this.modules.set(m.key, m);
    this.moduleList.push(m);
    // its Public variables are there at once (f.Counter = 1 before any event); declarations that would wait wait for its first event
    if (this.initialized) try { runSync(this.initModule(this.declRun, m), () => { throw new Error('waits'); }); } catch { /* at its first event */ }
  }

  *initModule(run: Run, m: ModuleScope): Gen<void> {
    const f = new Frame(run, m, null, 0);
    run.frames.push(f);
    try {
      for (const d of m.ast.variables) {
        f.line = d.line;
        let v: Variable;
        for (;;) {
          try {
            v = yield* declareVariable(f, d);
            break;
          } catch (e) {
            // no handlers at module level: reported (Continue retries) or ends the program
            if ((yield* handleError(f, e)) !== RETRY) throw e;
          }
        }
        if (d.withEvents) v.opts.events = { module: m };
        m.vars.set(lc(d.name), v);
        if (d.scope === 'public' && m.kind === 'module' && !this.globals.vars.has(lc(d.name))) {
          this.globals.vars.set(lc(d.name), v);
        }
      }
      m.initialized = true;
    } finally {
      run.frames.pop();
    }
  }

  /** The root generator of an event: initialise modules, then call the handler. */
  *entry(run: Run, ref: ProcRef, args: VBRef[], inst?: ClassInstance): Gen<VBValue> {
    yield* this.ensureInit(run);
    if (!ref.module.initialized) yield* this.initModule(run, ref.module);   // a form instance made after the start
    const bound: BoundArg[] = args.map(r => ({ slot: r }));
    const depth = this.callDepth;
    const r = (yield new SubCall(invokeProc(run, ref, bound, inst))) as VBValue;
    if (this.dying !== null) yield* reap(run, depth);
    return r;
  }

  /** Runs Class_Terminate of every object still alive (in the order they were made), as the program ends by itself. */
  *terminateAll(run: Run): Gen<void> {
    for (const inst of [...this.instances]) {
      if (inst.dead) continue;
      const t = inst.initPending ? undefined : inst.module.procs.get('class_terminate');
      this.dropInstance(inst);
      if (t) yield new SubCall(invokeProc(run, t, [], inst));
    }
  }
}

/**
 * A running VibeBasic program. Construct it with the project's modules (a
 * syntax error throws the first VBSyntaxError of the first faulty module, with
 * its `moduleName`), then call `runEvent` for Sub Main or event handlers.
 */
export class Program {
  private readonly rt: Runtime;
  /** Break-mode debugging: call stack, Locals, watches, data tips, Set Next Statement. */
  readonly debug: ProgramDebugger;

  constructor(modules: SourceModule[], host: Host, opts?: ProgramOptions) {
    this.rt = new Runtime(modules, host, opts);
    this.debug = new ProgramDebugger(this.rt);
  }

  get state(): ProgramState { return this.rt.state; }

  /** A path of the program as a full Mac path, like Open resolves it (relative to CurDir, which starts as App.Path). */
  resolvePath(path: string): string { return this.rt.files.resolve(path); }

  /** Resolves when the files the program left open at End are written and closed. */
  get filesClosed(): Promise<void> { return this.rt.filesClosed; }

  /** Runs `fn` with the program's locale current (date text and parsing), for work outside its code: data binding after an await. */
  inScope<T>(fn: () => T): T {
    const restore = this.rt.scope.activate();
    try { return fn(); } finally { restore(); }
  }

  /** Another instance of a form's module (New Form1): its own module-level variables under `name`, the same code. */
  addFormInstance(source: string, name: string): void { this.rt.addFormInstance(source, name); }

  hasProcedure(moduleName: string, procName: string): boolean {
    return this.rt.modules.get(lc(moduleName))?.procs.has(lc(procName)) ?? false;
  }

  /**
   * Runs a Sub (an event handler or Main) and resolves when it has finished.
   * ByRef parameters share the given VBRefs, so the caller sees changes
   * (KeyAscii = 0). Does nothing if the procedure does not exist, or while
   * the program is in break mode or has ended (the event is dropped).
   * Unhandled errors go to `host.onRuntimeError`; the promise always
   * resolves. A plain JS error thrown or rejected by host code (or a built-in)
   * is VB error 51 `Internal error: <message>` (catchable by On Error, logged
   * with console.error).
   *
   * Re-entrant: called while another handler waits in a host promise
   * (DoEvents, a dialog, an async method) or from inside a host call
   * (setMember firing a Change event), the new handler runs nested and the
   * waiting one resumes only after it has finished. Called while a handler
   * is in a time slice of a long loop, the event is queued and runs when that
   * handler finishes or reaches DoEvents (or any other host wait).
   */
  async runEvent(moduleName: string, procName: string, args: VBRef[] = []): Promise<void> {
    const rt = this.rt;
    if (!rt.acceptsEvents) return;
    const ref = rt.modules.get(lc(moduleName))?.procs.get(lc(procName));
    if (!ref) return;
    if (rt.runs.size >= MAX_EVENT_NESTING) {
      // VB6: Out of stack space. Raised by the statement that fired the event (afterHostCall / awaitHost).
      rt.overflow = true;
      return;
    }
    if (rt.busy) {
      // a handler is running a long stretch of code: VB6 handles this event after it (or at its next DoEvents)
      return new Promise<void>((resolve, reject) => {
        rt.queueEvent(() => { this.runEvent(moduleName, procName, args).then(resolve, reject); });
      });
    }
    const run = new Run(rt);
    const finish = rt.beginRun(run);
    rt.state = 'running';
    try {
      await runGenerator(rt.entry(run, ref, args), rt.runScope(run));
    } catch (e) {
      if (!(e instanceof EndSignal)) await this.entryError(ref, e);
    } finally {
      finish();
    }
  }

  /**
   * A Public member of a module as other code sees it (`Form2.Greet`, `Form2.Counter`): `'proc'` for a
   * Sub/Function that is not Private (procedures are Public by default), `'var'` for a `Public` variable,
   * else null.
   */
  hasPublicMember(moduleName: string, name: string): 'proc' | 'var' | 'prop' | null {
    const m = this.rt.modules.get(lc(moduleName));
    if (!m) return null;
    const key = lc(name);
    if (m.procs.get(key)?.proc.visibility === 'public') return 'proc';
    if (m.props.get(key)?.isPublic) return 'prop';
    if (m.ast.variables.some(d => d.scope === 'public' && lc(d.name) === key)) return 'var';
    return null;
  }

  /**
   * A Public Property of a module from host code (`Form2.Total`, `Form2.Total = 5`): runs its Property Get (`args` are the
   * index arguments) or its Property Let / Set (`value` is the new value: Set for an object when there is a Property Set)
   * like `callPublic`. Throws 438 when there is no such Public property procedure.
   */
  async callProperty(moduleName: string, name: string, args: VBValue[], value?: VBValue): Promise<VBValue> {
    const rt = this.rt;
    const prop = rt.modules.get(lc(moduleName))?.props.get(lc(name));
    const isObj = value !== undefined && typeof value === 'object' && (value instanceof NothingT || isObject(value));
    const ref = value === undefined ? prop?.get : isObj && prop?.set ? prop.set : prop?.let;
    if (!ref || ref.proc.visibility !== 'public') throw new VBRuntimeError(438);
    return this.callRef(ref, value === undefined ? args : [...args, value]);
  }

  /** The objects of class modules still alive. */
  get liveObjects(): number { return this.rt.instances.size; }

  /**
   * The program ends by itself (no form left): Class_Terminate runs for every object still alive (objects kept in
   * arrays, Collections or module-level variables), as VB6 releases them. Resolves when they have run.
   */
  async terminateObjects(): Promise<void> {
    const rt = this.rt;
    if (rt.instances.size === 0 || !rt.acceptsEvents) return;
    const run = new Run(rt);
    const finish = rt.beginRun(run);
    rt.state = 'running';
    try {
      await runGenerator(rt.terminateAll(run), rt.runScope(run));
    } catch (e) {
      if (!(e instanceof EndSignal)) console.error('VibeBasic: Class_Terminate failed', e);
    } finally {
      finish();
    }
  }

  /**
   * Calls a Public Sub/Function of a module from host code (`Form2.MyFunc(1)` on a form object) and resolves
   * with its result (Empty for a Sub). Runs like `runEvent`: started at once, nested in the statement that
   * asked (it awaits this promise), so it may be used inside an expression. Arguments are passed by value.
   * Unhandled errors in the procedure are reported as in an event handler (the promise resolves with Empty).
   * Throws 438 for a member that is not a Public procedure.
   */
  async callPublic(moduleName: string, name: string, args: VBValue[]): Promise<VBValue> {
    const rt = this.rt;
    if (this.hasPublicMember(moduleName, name) !== 'proc') throw new VBRuntimeError(438);
    return this.callRef(rt.modules.get(lc(moduleName))!.procs.get(lc(name))!, args);
  }

  private async callRef(ref: ProcRef, args: VBValue[]): Promise<VBValue> {
    const rt = this.rt;
    if (rt.state === 'ended') return Empty;
    if (rt.runs.size >= MAX_EVENT_NESTING) throw new VBRuntimeError(28);
    const run = new Run(rt);
    const finish = rt.beginRun(run);
    rt.state = 'running';
    try {
      return await runGenerator(rt.entry(run, ref, args.map(a => new VBRef(a))), rt.runScope(run));
    } catch (e) {
      if (!(e instanceof EndSignal)) await this.entryError(ref, e);
      return Empty;
    } finally {
      finish();
    }
  }

  /** The value of a Public module-level variable (Empty before the program has started). */
  getPublicVar(moduleName: string, name: string): VBValue {
    if (this.hasPublicMember(moduleName, name) !== 'var') throw new VBRuntimeError(438);
    return this.rt.modules.get(lc(moduleName))!.vars.get(lc(name))?.value ?? Empty;
  }

  /** Assigns a Public module-level variable, converted to its declared type. */
  setPublicVar(moduleName: string, name: string, value: VBValue): void {
    if (this.hasPublicMember(moduleName, name) !== 'var') throw new VBRuntimeError(438);
    const v = this.rt.modules.get(lc(moduleName))!.vars.get(lc(name));
    if (!v) throw new VBRuntimeError(91);
    v.set(value);
  }

  /**
   * An error that escaped every statement of an event run: raised outside any
   * statement (binding the handler's arguments), or a JS error that got past
   * the statement handling (error 51). Reported to onRuntimeError, then the
   * program ends; never rejects.
   */
  private async entryError(ref: ProcRef, e: unknown): Promise<void> {
    const rt = this.rt;
    if (rt.stopping) return;
    const err = e instanceof VBRuntimeError ? e : isStackOverflow(e) ? new VBRuntimeError(28) : internalError(e);
    const at: CodeLocation = { moduleName: ref.module.sourceName, procName: ref.proc.name, line: ref.proc.line };
    rt.err.setFrom(err);
    rt.eventsSuspended++;
    try {
      // nothing to break into (no statement ran): 'debug' ends the program too
      await rt.untilEnd(Promise.resolve().then(() => rt.host.onRuntimeError(err, at)));
    } catch (failed) {
      console.error('VibeBasic: onRuntimeError failed', failed);
    } finally {
      rt.eventsSuspended--;
    }
    rt.endProgram();
  }

  /**
   * The Immediate window. `? expr` / `Print expr` (Debug.Print items, `;` and
   * `,` allowed) returns the text Debug.Print would print; anything else runs
   * as one or more statements (`a = 1: Foo a`) and returns `''`.
   *
   * In break mode the command runs in the stopped frame: its locals, the
   * function result, its module's variables and the globals are visible and
   * can be changed. Otherwise it runs in a global context: Public variables,
   * procedures, constants and modules, but no locals and no Private module
   * variables (unknown names are new, empty Immediate variables).
   *
   * A run-time error returns `Run-time error '<n>': <text>`; syntax errors
   * and compile errors return `Compile error: <text>`, and Dim/Static/Const,
   * On Error, Resume, GoTo and labels give `Compile error: Invalid in
   * Immediate window`. Errors never reach host.onRuntimeError or break
   * mode (procedures called from here still use their own On Error
   * handlers), and Stop does nothing. `End` ends the program and returns `''`.
   */
  immediate(text: string): Promise<string> {
    return runImmediate(this.rt, text);
  }

  /** The variables of the frame stopped in break mode as short text; empty outside break mode. See snapshotVariables. */
  snapshotVariables(): { name: string; value: string }[] {
    return snapshotVariables(this.rt.state === 'break' ? this.rt.breakFrame : undefined);
  }

  /**
   * Break mode at the next statement boundary: host.onBreak with reason
   * 'pause' at the innermost running statement; 'continue' goes on, 'end'
   * ends the program. With no code running, onBreak is called at once with
   * an empty location (`procName: ''`); the state is 'break' until it answers
   * (a rejected onBreak counts as 'continue', here and for a pause or Stop during a run; after an error it ends the program). Ignored
   * while only an Immediate command runs.
   */
  requestPause(): void {
    const rt = this.rt;
    if (rt.state === 'ended' || rt.state === 'break') return;
    if (rt.activeRuns > 0) {
      rt.pauseRequested = true;
      return;
    }
    // only an Immediate command runs: it never breaks, and break mode would stop nothing
    if (rt.immediateRuns > 0) return;
    rt.pauseIdle();
  }

  /**
   * Breakpoints of a module (replacing its previous ones): the program
   * enters break mode (reason 'pause') before a statement on one of these
   * lines runs, when the line is reached (not again while it stays on that
   * line). Never in an Immediate command. Lines are 1-based source lines.
   */
  setBreakpoints(moduleName: string, lines: Iterable<number>): void {
    this.rt.setBreakpoints(moduleName, lines);
  }

  /** Run To Cursor: a one-shot breakpoint, removed by the next break of any kind. */
  runToLine(moduleName: string, line: number): void {
    this.rt.setRunTo(moduleName, line);
  }

  /**
   * Arms a step; call it in break mode before answering onBreak with
   * 'continue' (or before the first event, to break at the first statement).
   * - 'into': break at the next statement that runs, in any procedure;
   * - 'over': break at the next statement in this procedure or a caller
   *   (calls run to completion);
   * - 'out': break at the next statement in a caller.
   * Stays armed while the program waits for events (the next event handler
   * breaks for 'into' and, at the top level, 'over'); any break ends it.
   */
  step(mode: 'into' | 'over' | 'out'): void {
    const rt = this.rt;
    const depth = rt.callDepth;
    rt.stepDepth = mode === 'into' || depth === 0 ? (mode === 'out' ? -1 : Infinity) : mode === 'over' ? depth : depth - 1;
  }

  /**
   * Ends the program (the IDE's End button): running code stops, every wait
   * (host promises, nested events, a pending onBreak) is cancelled, queued
   * events are dropped, every runEvent promise resolves, state is 'ended' and
   * host.onEnd() is called once.
   */
  end(): void {
    this.rt.endProgram();
  }
}
