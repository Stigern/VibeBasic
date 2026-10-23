// Storage and scopes for the interpreter: variables, by-reference slots,
// call frames, module scopes and the global scope.

import type { ConstDecl, EnumDecl, ModuleAst, ProcDecl, TypeDecl, VBTypeName } from '../ast';
import type { CodeLocation, OutSlot, VBObject } from '../host';
import type { Builtin } from '../builtins';
import { VBRuntimeError } from '../errors';
import { Nothing, NothingT, VBArray, VBRecord, coerce, fitFixed, type VBValue } from '../values';
import type { Runtime } from './program';

const LOWER = new Map<string, string>();

/** Lower-case name key (names are case-insensitive). Cached. */
export function lc(name: string): string {
  let k = LOWER.get(name);
  if (k === undefined) {
    k = name.toLowerCase();
    LOWER.set(name, k);
  }
  return k;
}

/** Something that holds a value by reference. `VBRef` is one; so are array elements and record fields. */
export interface Slot { value: VBValue }

/** An array element passed ByRef (`Swap a(1), a(2)`). */
export class ElementSlot implements Slot {
  constructor(readonly array: VBArray, readonly index: number[]) {}
  get value(): VBValue { return this.array.get(this.index); }
  set value(v: VBValue) { escape(v); this.array.set(this.index, v); }
}

/** A record field passed ByRef (`Inc p.Age`). Stores with the field's conversion. */
export class FieldSlot implements Slot {
  constructor(readonly rt: Runtime, readonly record: VBRecord, readonly key: string) {}
  get value(): VBValue { return this.record.fields.get(this.key)!; }
  set value(v: VBValue) { setField(this.rt, this.record, this.key, v); }
}

/**
 * The slot of `Dim x As New T`: reading it while it holds Nothing creates a new object first (VB6 auto-instantiation,
 * also after `Set x = Nothing`).
 */
export class AutoNewSlot implements Slot {
  private v: VBValue = Nothing;
  constructor(private readonly create: () => VBValue) {}
  get value(): VBValue {
    if (this.v instanceof NothingT) {
      this.v = this.create();
      if (this.v instanceof ClassValue) this.v.inst.refs++;   // the slot holds the new object
    }
    return this.v;
  }
  set value(v: VBValue) { this.v = v; }
  /** The value without creating an object. */
  peek(): VBValue { return this.v; }
}

/** The value a slot holds, without making the object of a `Dim x As New T` slot. */
export const rawValue = (r: Slot): VBValue => (r instanceof AutoNewSlot ? r.peek() : r.value);

export { fitFixed } from '../values';

/** Converts `v` for storing in a slot of type `t`: records and arrays are copied (value semantics), then coerced. */
export function storeValue(v: VBValue, t: VBTypeName, fixedLength?: number): VBValue {
  if (v instanceof VBRecord || v instanceof VBArray) v = v.clone();
  const r = coerce(v, t);
  return fixedLength === undefined ? r : fitFixed(r as string, fixedLength);
}

export interface VarOptions {
  /** Declared as an array (`a()` or `a(10)`); the value is always a VBArray. */
  isArray?: boolean;
  /** `Dim a(10)`: cannot be assigned as a whole. */
  fixedArray?: boolean;
  /** `As String * n`. */
  fixedLength?: number;
  /** A `Const`. */
  isConst?: boolean;
  /**
   * A Variant parameter sharing a typed variable of the caller (ByRef, `Sub F(v)` called with an Integer array): its
   * elements are Variants to the static types (staticTypes.ts), whatever the array holds.
   */
  variantAlias?: boolean;
  /** The slot is not the frame's own (a ByRef parameter, a Static variable): leaving the procedure releases nothing. */
  shared?: boolean;
  /** `WithEvents`: the module (and object, in a class) whose `name_Event` procedures handle the events of the value. */
  events?: { module: ModuleScope; instance?: ClassInstance };
}

/** A named variable. `ref` may be shared with a caller (ByRef parameters). */
export class Variable {
  /**
   * A Variant variable last assigned a number from a typed expression: that type (`v = CDbl(5)` is a Double for
   * TypeName), valid while the variable still holds `subOf`.
   */
  sub?: VBTypeName | 'Decimal' = undefined;
  subOf?: VBValue = undefined;

  constructor(
    readonly name: string,
    readonly type: VBTypeName,
    public ref: Slot,
    readonly opts: VarOptions = {},
  ) {}

  get value(): VBValue { return this.ref.value; }

  /** Assignment (`x = v`), with VB conversion to the declared type. */
  set(v: VBValue): void {
    const o = this.opts;
    if (o.isConst) throw VBRuntimeError.compile('Assignment to constant not permitted');
    if (o.isArray) {
      if (o.fixedArray) throw VBRuntimeError.compile("Can't assign to array");
      if (!(v instanceof VBArray)) throw new VBRuntimeError(13);
      this.ref.value = v.clone();
      return;
    }
    if (classesInUse) { this.store(storeValue(v, this.type, o.fixedLength)); return; }
    this.ref.value = storeValue(v, this.type, o.fixedLength);
  }

  /** Stores an already converted value, counting the references of class objects (and moving a WithEvents sink). */
  store(nv: VBValue): void {
    const r = this.ref;
    const prev = rawValue(r);
    r.value = nv;
    if (prev === nv) return;
    if (nv instanceof ClassValue) nv.inst.refs++;
    if (this.opts.events) {
      if (prev instanceof ClassValue) prev.inst.sinks?.delete(this);
      if (nv instanceof ClassValue) (nv.inst.sinks ??= new Set()).add(this);
    }
    if (prev instanceof ClassValue) prev.inst.release();
  }
}

// ---------------------------------------------------------------------------
// Objects of class modules
// ---------------------------------------------------------------------------

/**
 * Set when the first object of a class module is made: from then on assignments count references (`Variable.store`),
 * so that a program without classes pays nothing for it.
 */
export let classesInUse = false;

/**
 * An object of a class module as a value: the object itself (`ClassInstance`) or the object seen through an interface
 * it implements (`InterfaceView`, the value of a variable declared `As IFoo`). The interpreter calls its members with
 * the class's procedures (eval.ts `classGet` ...); the VBObject methods are for host code, which can only read and
 * write Public variables.
 */
export abstract class ClassValue implements VBObject {
  abstract readonly inst: ClassInstance;
  /** Lower-case interface name for a view (members are the class's `IFoo_Name` procedures); undefined for the object. */
  abstract readonly iface: string | undefined;
  get vbTypeName(): string { return this.inst.module.name; }
  /** `Is` compares objects, not views. */
  get identity(): VBObject { return this.inst; }

  hasMember(name: string): boolean {
    const m = this.inst.module;
    const k = this.iface ? `${this.iface}_${lc(name)}` : lc(name);
    if (this.iface) return m.procs.has(k) || m.props.has(k);
    return m.publicVars.has(k) || m.procs.get(k)?.proc.visibility === 'public' || m.props.has(k);
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const v = this.iface ? undefined : this.inst.publicVar(lc(name));
    if (!v) throw new VBRuntimeError(438);
    if (args.length === 0) return v.value;
    const arr = v.value;
    if (!(arr instanceof VBArray)) throw new VBRuntimeError(13);
    return arr.get(args.map(a => coerce(a, 'Long') as number));
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const v = this.iface || args.length ? undefined : this.inst.publicVar(lc(name));
    if (!v) throw new VBRuntimeError(438);
    v.set(value);
  }

  callMethod(_name: string, _args: VBValue[], _refs?: (OutSlot | undefined)[]): VBValue {
    throw new VBRuntimeError(438);
  }

  /** The object as a value of type `name`: itself, a view for an interface it implements, or undefined (Type mismatch). */
  asType(name: string, _strict?: boolean): VBObject | undefined {
    const k = lc(name.slice(name.lastIndexOf('.') + 1));
    const inst = this.inst;
    if (k === 'object' || k === inst.module.key) return inst;
    return inst.module.implementsKeys.has(k) ? inst.view(k) : undefined;
  }
}

/** One object of a class module: its own module-level variables, a reference count, its WithEvents sinks. */
export class ClassInstance extends ClassValue {
  readonly vars = new Map<string, Variable>();
  /** References held by variables (Variable.store, AutoNewSlot, parameters, With blocks). */
  refs = 0;
  /** Stored somewhere references are not counted (an array, a Collection, a record, host code): never terminated early. */
  escaped = false;
  /** Class_Terminate has run (or is running). */
  dead = false;
  /** Waiting in `Runtime.dying` for the end of the statement. */
  dying = false;
  /** Class_Initialize has not run yet (a `Dim x As New T` object runs it when it is first used). */
  initPending = true;
  /** WithEvents variables that hold this object. */
  sinks?: Set<Variable>;
  private views?: Map<string, InterfaceView>;
  private statics?: Map<ProcDecl, Map<string, Variable>>;

  constructor(readonly rt: Runtime, readonly module: ModuleScope) {
    super();
    classesInUse = true;
  }

  get inst(): ClassInstance { return this; }
  get iface(): undefined { return undefined; }

  view(iface: string): InterfaceView {
    let v = (this.views ??= new Map()).get(iface);
    if (!v) { v = new InterfaceView(this, iface); this.views.set(iface, v); }
    return v;
  }

  publicVar(key: string): Variable | undefined {
    return this.module.publicVars.has(key) ? this.vars.get(key) : undefined;
  }

  /** Static variables of a procedure: each object has its own. */
  staticStore(p: ProcDecl): Map<string, Variable> {
    const all = (this.statics ??= new Map());
    let s = all.get(p);
    if (!s) { s = new Map(); all.set(p, s); }
    return s;
  }

  /** One reference less; at none the object waits for the end of the statement (it may still be stored, a returned Function value). */
  release(): void {
    if (--this.refs <= 0 && !this.escaped && !this.dead && !this.dying) {
      this.dying = true;
      this.rt.queueDying(this);
    }
  }
}

/** A class object seen through an interface it implements (`Implements IFoo`). */
export class InterfaceView extends ClassValue {
  constructor(readonly inst: ClassInstance, readonly iface: string) { super(); }
}

/** A value now held by one more counted reference. */
export function retain(v: VBValue): void {
  if (v instanceof ClassValue) v.inst.refs++;
}

/** A counted reference to `v` went away. */
export function release(v: VBValue): void {
  if (v instanceof ClassValue) v.inst.release();
}

/** `v` is stored where references are not counted: its object lives until the program ends. */
export function escape(v: VBValue): void {
  if (v instanceof ClassValue) v.inst.escaped = true;
}

/** Field layout of a user-defined type. */
export interface FieldInfo {
  name: string;
  type: VBTypeName;
  fixedLength?: number;
  isArray: boolean;
  /** Evaluated bounds of a fixed array field; undefined for a dynamic one. */
  bounds?: [number, number][];
}

export interface TypeInfo {
  decl: TypeDecl;
  module: ModuleScope;
  fields: Map<string, FieldInfo>;
}

/** `rec.field = v` with the field's declared type. */
export function setField(rt: Runtime, rec: VBRecord, key: string, v: VBValue): void {
  escape(v);
  const info = rt.typeInfo(rec.typeName).fields.get(key);
  if (!info) throw VBRuntimeError.compile('Method or data member not found');
  if (info.isArray) {
    if (info.bounds) throw VBRuntimeError.compile("Can't assign to array");
    if (!(v instanceof VBArray)) throw new VBRuntimeError(13);
    rec.fields.set(key, v.clone());
    return;
  }
  rec.fields.set(key, storeValue(v, info.type, info.fixedLength));
}

export function getField(rec: VBRecord, name: string): VBValue {
  const v = rec.fields.get(lc(name));
  if (v === undefined) throw VBRuntimeError.compile('Method or data member not found');
  return v;
}

// ---------------------------------------------------------------------------
// Name bindings (what a name resolves to)
// ---------------------------------------------------------------------------

/** A Sub or Function (or one Property procedure). */
export class ProcRef {
  constructor(readonly module: ModuleScope, readonly proc: ProcDecl) {}
}

/** The Property Get / Let / Set procedures of one property name. */
export class PropRef {
  get?: ProcRef;
  let?: ProcRef;
  set?: ProcRef;
  constructor(readonly module: ModuleScope, readonly name: string) {}
  /** Public when one of its procedures is (VB6 allows `Public Property Get` with a `Private Property Let`). */
  get isPublic(): boolean {
    return [this.get, this.let, this.set].some(r => r?.proc.visibility === 'public');
  }
}

/** A built-in function from BUILTINS. */
export class BuiltinRef {
  constructor(readonly name: string, readonly builtin: Builtin) {}
}

/** A fixed value: enum member or built-in constant. */
export class ValueRef {
  constructor(readonly value: VBValue) {}
}

/** An Enum type name (`Color` in `Color.Red`). */
export class EnumRef {
  readonly members = new Map<string, number>();
  constructor(readonly decl: EnumDecl) {
    for (const m of decl.members) this.members.set(lc(m.name), m.value);
  }
}

/** A standard module name (`Module1` in `Module1.Total`). */
export class ModuleRef {
  constructor(readonly module: ModuleScope) {}
}

/** A host object (`Text1`, `Form2`, `App`). */
export class ObjectRef {
  constructor(readonly obj: VBObject) {}
}

/** Module-level or public constant, evaluated on first use. */
export class ConstSlot {
  variable?: Variable;
  evaluating = false;
  constructor(readonly decl: ConstDecl, readonly module: ModuleScope) {}
}

/**
 * A property of the form itself used without `Me.` in the form's own code
 * (`Caption = "x"`, `Width`): reads are `getMember`, assignments `setMember`.
 */
export class MemberRef {
  constructor(readonly obj: VBObject, readonly name: string) {}
}

export type Binding = Variable | ProcRef | PropRef | BuiltinRef | ValueRef | EnumRef | ModuleRef | ObjectRef | MemberRef;

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** One module (form, standard module or class module) and its module-level names. */
export class ModuleScope {
  readonly key: string;
  /** Module-level variables (created when the program starts); a class module's are in each object (`ClassInstance.vars`). */
  readonly vars = new Map<string, Variable>();
  readonly consts = new Map<string, ConstSlot>();
  readonly procs = new Map<string, ProcRef>();
  /** Property Get/Let/Set procedures by property name. */
  readonly props = new Map<string, PropRef>();
  /** Lower-case names of the Public module-level variables (a class's properties). */
  readonly publicVars = new Set<string>();
  /** Lower-case names of the declared events. */
  readonly events = new Set<string>();
  /** Lower-case names of the interfaces of `Implements`. */
  readonly implementsKeys = new Set<string>();
  readonly enumMembers = new Map<string, ValueRef>();
  readonly enums = new Map<string, EnumRef>();
  readonly types = new Map<string, TypeDecl>();
  readonly ref: ModuleRef;
  initialized = false;
  /** Lines where the program breaks (breakpoints and a Run To Cursor line); null when there are none. */
  breakpoints: Set<number> | null = null;

  /** `sourceName`: the module whose code this is, when it differs from `name` (another instance of a form, `New Form1`: its own
   *  module-level variables; locations and breakpoints are the source module's). */
  constructor(readonly name: string, readonly kind: 'form' | 'module' | 'class', readonly ast: ModuleAst, readonly sourceName: string = name) {
    this.key = lc(name);
    this.ref = new ModuleRef(this);
    for (const c of ast.consts) this.consts.set(lc(c.name), new ConstSlot(c, this));
    for (const p of ast.procedures) {
      const k = lc(p.name);
      if (!p.property) { this.procs.set(k, new ProcRef(this, p)); continue; }
      let pr = this.props.get(k);
      if (!pr) { pr = new PropRef(this, p.name); this.props.set(k, pr); }
      pr[p.property] = new ProcRef(this, p);
    }
    for (const d of ast.variables) if (d.scope === 'public') this.publicVars.add(lc(d.name));
    for (const e of ast.events ?? []) this.events.add(lc(e.name));
    for (const i of ast.implements ?? []) this.implementsKeys.add(lc(i.slice(i.lastIndexOf('.') + 1)));
    for (const e of ast.enums) {
      const er = new EnumRef(e);
      this.enums.set(lc(e.name), er);
      for (const m of e.members) this.enumMembers.set(lc(m.name), new ValueRef(m.value));
    }
    for (const t of ast.types) this.types.set(lc(t.name), t);
  }

  get optionExplicit(): boolean { return this.ast.optionExplicit; }
  /** `Option Base`: the lower bound of `Dim a(5)` and `Array()`. */
  get optionBase(): number { return this.ast.optionBase ?? 0; }
  /** `Option Compare Text`. */
  get textCompare(): boolean { return this.ast.optionCompareText === true; }
}

/** Names visible from every module: Public items of standard modules. */
export class GlobalScope {
  readonly vars = new Map<string, Variable>();
  readonly consts = new Map<string, ConstSlot>();
  readonly procs = new Map<string, ProcRef>();
  readonly props = new Map<string, PropRef>();
  readonly enumMembers = new Map<string, ValueRef>();
  readonly enums = new Map<string, EnumRef>();
  readonly types = new Map<string, { decl: TypeDecl; module: ModuleScope }>();
  /** Standard modules by name. */
  readonly modules = new Map<string, ModuleRef>();

  /** Adds the public names of a standard module (first one wins on clashes). */
  addModule(m: ModuleScope): void {
    const setOnce = <V>(map: Map<string, V>, k: string, v: V) => { if (!map.has(k)) map.set(k, v); };
    setOnce(this.modules, m.key, m.ref);
    for (const [k, c] of m.consts) if (c.decl.scope === 'public') setOnce(this.consts, k, c);
    for (const [k, p] of m.procs) if (p.proc.visibility === 'public') setOnce(this.procs, k, p);
    for (const [k, p] of m.props) if (p.isPublic) setOnce(this.props, k, p);
    for (const e of m.ast.enums) {
      if (e.visibility !== 'public') continue;
      setOnce(this.enums, lc(e.name), m.enums.get(lc(e.name))!);
      for (const mem of e.members) setOnce(this.enumMembers, lc(mem.name), m.enumMembers.get(lc(mem.name))!);
    }
    for (const t of m.ast.types) if (t.visibility === 'public') setOnce(this.types, lc(t.name), { decl: t, module: m });
  }
}

/** One activation of a Sub/Function (or a module's declarations section when `proc` is null). */
export class Frame {
  readonly locals = new Map<string, Variable>();
  /** Objects of the enclosing `With` blocks, innermost last. */
  readonly withStack: VBValue[] = [];
  /** A Function's result variable (also in `locals` under the function name). */
  returnVar?: Variable;
  /** The frame's `On Error` setting: none (`GoTo 0`), `Resume Next`, or `GoTo handlerLabel`. */
  onError: 'none' | 'resumeNext' | 'goto' = 'none';
  /** Lower-case label of `On Error GoTo label`. */
  handlerLabel = '';
  /** True while the `GoTo` handler runs (until Resume or the procedure ends); a new error then goes to the caller. */
  inHandler = false;
  /** The last line number label (`20 x = 1`) passed, for `Erl`; 0 when there is none. */
  lastLine = 0;
  /** `GoSub`s waiting for their `Return`. */
  gosubDepth = 0;
  /** The module-level variables the code sees: the module's, or in a class module the object's. */
  readonly vars: Map<string, Variable>;

  constructor(
    readonly run: Run,
    readonly module: ModuleScope,
    readonly proc: ProcDecl | null,
    /** Line of the statement being executed. */
    public line: number,
    /** In a class module: the object (`Me`). */
    readonly instance?: ClassInstance,
  ) {
    this.vars = instance ? instance.vars : module.vars;
  }

  get rt(): Runtime { return this.run.rt; }

  location(): CodeLocation {
    return { moduleName: this.module.sourceName, procName: this.proc?.name ?? '', line: this.line };
  }
}

/** One running event handler (or Immediate command): its call stack, innermost frame last. */
export class Run {
  readonly frames: Frame[] = [];
  /** Start order among runs (0: not an event run); a run waits for runs with a higher seq (nested events). */
  seq = 0;
  /** Resolves when the run has finished (set for event runs). */
  done?: Promise<void>;
  /** An Immediate-window command: errors are returned as text, never reported or turned into break mode. */
  immediate = false;
  constructor(readonly rt: Runtime) {}

  get top(): Frame | undefined { return this.frames[this.frames.length - 1]; }
}
