// Public API of the interpreter (Program) and its shared state (Runtime).

import type { ProcDecl, TypeDecl, VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import type { BuiltinCtx } from '../builtins';
import type { CodeLocation, Host } from '../host';
import { generalDateText } from '../builtins/format';
import { newRndState } from '../builtins/util';
import { parseModule } from '../parser';
import { VBArray, VBRecord, VBRef, defaultValue, setDateTextFormatter, toNumber, type DateTextFormatter, type VBValue } from '../values';
import { EndSignal, SubCall, runGenerator, type ExecScope, type Gen } from './driver';
import { constExpr } from './eval';
import { declareVariable, evalBounds, handleError, invokeProc, isStackOverflow, type BoundArg } from './exec';

/**
 * Event handlers nested in each other (an event fired while another handler
 * waits or sets a property) beyond this depth are error 28, Out of stack
 * space. Synchronously fired events nest on the JS stack, so this stays well
 * below what the JS engine allows.
 */
export const MAX_EVENT_NESTING = 100;
import {
  Frame, GlobalScope, ModuleScope, ProcRef, Run, Variable, fitFixed, lc, type FieldInfo, type TypeInfo,
} from './scope';

export interface SourceModule { name: string; kind: 'form' | 'module'; source: string }
export interface ProgramOptions {
  sliceSize?: number /* default 10000 */;
  locale?: string;
  /** Default MsgBox/InputBox title (default 'Project1'). */
  appTitle?: string;
}

export type ProgramState = 'idle' | 'running' | 'break' | 'ended';

/** Shared interpreter state: modules, globals, flags. Internal; `Program` is the public face. */
export class Runtime {
  state: ProgramState = 'idle';
  /** Set when the program ends; running code stops at the next statement boundary. */
  stopping = false;
  /** Set by requestPause; the next statement boundary enters break mode. */
  pauseRequested = false;
  /** Statements since the last time slice. */
  stmtCount = 0;
  /** Column of an unfinished Debug.Print line (after a trailing `;` or `,`). */
  printColumn = 0;
  /** Event handlers currently running (nested ones count too). */
  activeRuns = 0;
  /** The runs behind `activeRuns`, each with its call stack (for End and break mode). */
  readonly runs = new Set<Run>();
  /** The frame that is stopped in break mode (Immediate evaluates there; Task 8). */
  breakFrame?: Frame;
  /** Runs currently waiting in a time slice (`nextTick`); events arriving meanwhile are queued. */
  slicing = 0;
  /** Events that arrived during a time slice, started at the next event pump or when the run finishes. */
  private readonly eventQueue: (() => void)[] = [];
  private runSeq = 0;
  /** Waits for nested runs (`nestedRuns`) that the end of the program must release; each removes itself when done. */
  readonly endWaiters = new Set<() => void>();
  /**
   * > 0 while an unhandled error is being reported (and, in Task 8, while
   * onBreak is pending): no event pump, new events are dropped.
   */
  eventsSuspended = 0;
  /** Set when an event was refused for nesting too deep; the running statement raises error 28. */
  overflow = false;
  readonly sliceSize: number;
  readonly locale: string;
  readonly builtinCtx: BuiltinCtx;
  /** Makes this program's locale (date text) current while its code runs; pass to `runGenerator`. */
  readonly scope: ExecScope;
  private readonly dateText: DateTextFormatter;
  readonly modules = new Map<string, ModuleScope>();
  readonly moduleList: ModuleScope[] = [];
  readonly globals = new GlobalScope();
  private readonly statics = new Map<ProcDecl, Map<string, Variable>>();
  private readonly declRun: Run;
  private readonly declFrames = new Map<ModuleScope, Frame>();
  private readonly resolvedTypes = new WeakMap<object, VBTypeName>();
  private readonly typeInfos = new Map<string, TypeInfo>();
  private initialized = false;

  constructor(sources: SourceModule[], readonly host: Host, opts: ProgramOptions = {}) {
    this.sliceSize = Math.max(1, opts.sliceSize ?? 10000);
    this.locale = opts.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
    this.builtinCtx = { host, locale: this.locale, appTitle: opts.appTitle ?? 'Project1', rnd: newRndState() };
    this.dateText = v => generalDateText(v.serial, this.locale);
    this.scope = {
      activate: () => {
        const prev = setDateTextFormatter(this.dateText);
        return () => { setDateTextFormatter(prev); };
      },
    };
    this.declRun = new Run(this);
    for (const src of sources) {
      const m = new ModuleScope(src.name, src.kind, parseModule(src.source, src.name));
      this.modules.set(m.key, m);
      this.moduleList.push(m);
      if (m.kind === 'module') this.globals.addModule(m);
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
          b.lower ? toNumber(constExpr(frame, b.lower)) : 0,
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
      if (fi.isArray) fields.set(k, fi.bounds ? this.newArray(fi.type, fi.bounds, true) : this.unallocatedArray(fi.type));
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

  newArray(t: VBTypeName, bounds: [number, number][], fixed: boolean): VBArray {
    return new VBArray(t, bounds, fixed, this.elementInit(t));
  }

  unallocatedArray(t: VBTypeName): VBArray {
    return VBArray.unallocated(t, this.elementInit(t));
  }

  /** Initial value of a variable of type `t` (`String * n` starts as n spaces). */
  defaultFor(t: VBTypeName, fixedLength?: number): VBValue {
    if (typeof t === 'object' && 'userType' in t) return this.newRecord(t.userType);
    if (fixedLength !== undefined) return fitFixed('', fixedLength);
    return defaultValue(t);
  }

  // ---- lifecycle ----

  /** Ends the program once: state 'ended', running code stops, host.onEnd(). */
  endProgram(): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.stopping = true;
    this.pauseRequested = false;
    const waiters = [...this.endWaiters];
    this.endWaiters.clear();
    for (const w of waiters) w();
    this.host.onEnd();
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

  /** Registers an event run: start order and a promise that resolves when it finishes. */
  beginRun(run: Run): () => void {
    let finish!: () => void;
    run.seq = ++this.runSeq;
    run.done = new Promise<void>(r => { finish = r; });
    this.activeRuns++;
    this.runs.add(run);
    return () => {
      this.runs.delete(run);
      this.activeRuns--;
      if (this.activeRuns === 0 && this.state === 'running') this.state = 'idle';
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

  /** The driver scope of an event run: locale, event pump before awaits, nested runs after. */
  runScope(run: Run): ExecScope {
    return {
      activate: this.scope.activate,
      beforeAwait: () => { if (this.slicing === 0) this.drainEvents(); },
      afterAwait: () => this.nestedRuns(run),
    };
  }

  /** Creates module-level variables (once, before the first event runs). */
  *ensureInit(run: Run): Gen<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const m of this.moduleList) {
      const f = new Frame(run, m, null, 0);
      run.frames.push(f);
      try {
        for (const d of m.ast.variables) {
          f.line = d.line;
          let v: Variable;
          try {
            v = yield* declareVariable(f, d);
          } catch (e) {
            yield* handleError(f, e); // reports and ends (no handlers at module level)
            throw e;
          }
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
  }

  /** The root generator of an event: initialise modules, then call the handler. */
  *entry(run: Run, ref: ProcRef, args: VBRef[]): Gen<VBValue> {
    yield* this.ensureInit(run);
    const bound: BoundArg[] = args.map(r => ({ slot: r }));
    return (yield new SubCall(invokeProc(run, ref, bound))) as VBValue;
  }
}

/**
 * A running VibeBasic program. Construct it with the project's modules (a
 * syntax error throws VBSyntaxError), then call `runEvent` for Sub Main or
 * event handlers.
 */
export class Program {
  private readonly rt: Runtime;

  constructor(modules: SourceModule[], host: Host, opts?: ProgramOptions) {
    this.rt = new Runtime(modules, host, opts);
  }

  get state(): ProgramState { return this.rt.state; }

  hasProcedure(moduleName: string, procName: string): boolean {
    return this.rt.modules.get(lc(moduleName))?.procs.has(lc(procName)) ?? false;
  }

  /**
   * Runs a Sub (an event handler or Main) and resolves when it has finished.
   * ByRef parameters share the given VBRefs, so the caller sees changes
   * (KeyAscii = 0). Does nothing if the procedure does not exist, or while
   * the program is in break mode or has ended (the event is dropped).
   * Unhandled errors go to `host.onRuntimeError`; the promise still resolves.
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
      const err = isStackOverflow(e) ? new VBRuntimeError(28) : e;
      if (err instanceof VBRuntimeError) {
        // raised outside any statement, e.g. binding the handler's arguments
        if (!rt.stopping) {
          const at: CodeLocation = { moduleName: ref.module.name, procName: ref.proc.name, line: ref.proc.line };
          rt.eventsSuspended++;
          try {
            await rt.host.onRuntimeError(err, at);
          } finally {
            rt.eventsSuspended--;
          }
          rt.endProgram();
        }
      } else if (!(err instanceof EndSignal)) {
        throw err;
      }
    } finally {
      finish();
    }
  }

  /** Immediate window (Task 8). */
  async immediate(_text: string): Promise<string> {
    throw new Error('Program.immediate is not implemented yet');
  }

  /**
   * Break at the next statement boundary (host.onBreak with reason 'pause').
   * With no code running, onBreak is called right away with an empty location.
   * (Minimal; Task 8 completes break mode.)
   */
  requestPause(): void {
    const rt = this.rt;
    if (rt.state === 'ended' || rt.state === 'break') return;
    if (rt.activeRuns > 0) {
      rt.pauseRequested = true;
      return;
    }
    rt.state = 'break';
    void rt.host.onBreak({ reason: 'pause', at: { moduleName: '', procName: '', line: 0 } }).then(answer => {
      if (answer === 'end') rt.endProgram();
      else if (rt.state === 'break') rt.state = 'idle';
    });
  }

  /** Ends the program: running code stops at its next statement, host.onEnd() is called once. */
  end(): void {
    this.rt.endProgram();
  }
}
