// Public API of the interpreter (Program) and its shared state (Runtime).

import type { ProcDecl, TypeDecl, VBTypeName } from '../ast';
import { VBRuntimeError } from '../errors';
import type { BuiltinCtx } from '../builtins';
import type { CodeLocation, Host } from '../host';
import { generalDateText } from '../builtins/format';
import { parseModule } from '../parser';
import { VBArray, VBRecord, VBRef, defaultValue, setDateTextFormatter, toNumber, type VBValue } from '../values';
import { EndSignal, SubCall, runGenerator, type Gen } from './driver';
import { constExpr } from './eval';
import { declareVariable, evalBounds, handleError, invokeProc, type BoundArg } from './exec';
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
  readonly sliceSize: number;
  readonly locale: string;
  readonly builtinCtx: BuiltinCtx;
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
    this.builtinCtx = { host, locale: this.locale, appTitle: opts.appTitle ?? 'Project1' };
    setDateTextFormatter(v => generalDateText(v.serial, this.locale));
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
    this.host.onEnd();
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
   * the program is in break mode or has ended. Unhandled errors go to
   * `host.onRuntimeError`; the promise still resolves.
   */
  async runEvent(moduleName: string, procName: string, args: VBRef[] = []): Promise<void> {
    const rt = this.rt;
    if (rt.state === 'ended' || rt.state === 'break') return;
    const ref = rt.modules.get(lc(moduleName))?.procs.get(lc(procName));
    if (!ref) return;
    const run = new Run(rt);
    rt.activeRuns++;
    rt.runs.add(run);
    rt.state = 'running';
    try {
      await runGenerator(rt.entry(run, ref, args));
    } catch (e) {
      if (e instanceof VBRuntimeError) {
        // raised outside any statement, e.g. binding the handler's arguments
        if (!rt.stopping) {
          const at: CodeLocation = { moduleName: ref.module.name, procName: ref.proc.name, line: ref.proc.line };
          await rt.host.onRuntimeError(e, at);
          rt.endProgram();
        }
      } else if (!(e instanceof EndSignal)) {
        throw e;
      }
    } finally {
      rt.runs.delete(run);
      rt.activeRuns--;
      if (rt.activeRuns === 0 && rt.state === 'running') rt.state = 'idle';
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
