// Storage and scopes for the interpreter: variables, by-reference slots,
// call frames, module scopes and the global scope.

import type { ConstDecl, EnumDecl, ModuleAst, ProcDecl, TypeDecl, VBTypeName } from '../ast';
import type { CodeLocation, VBObject } from '../host';
import type { Builtin } from '../builtins';
import { VBRuntimeError } from '../errors';
import { VBArray, VBRecord, coerce, type VBValue } from '../values';
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
  set value(v: VBValue) { this.array.set(this.index, v); }
}

/** A record field passed ByRef (`Inc p.Age`). Stores with the field's conversion. */
export class FieldSlot implements Slot {
  constructor(readonly rt: Runtime, readonly record: VBRecord, readonly key: string) {}
  get value(): VBValue { return this.record.fields.get(this.key)!; }
  set value(v: VBValue) { setField(this.rt, this.record, this.key, v); }
}

/** Pads or truncates to a `String * n` length. */
export function fitFixed(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s.padEnd(n, ' ');
}

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
}

/** A named variable. `ref` may be shared with a caller (ByRef parameters). */
export class Variable {
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
    this.ref.value = storeValue(v, this.type, o.fixedLength);
  }
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

/** A Sub or Function. */
export class ProcRef {
  constructor(readonly module: ModuleScope, readonly proc: ProcDecl) {}
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

export type Binding = Variable | ProcRef | BuiltinRef | ValueRef | EnumRef | ModuleRef | ObjectRef;

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** One module (form or standard module) and its module-level names. */
export class ModuleScope {
  readonly key: string;
  /** Module-level variables (created when the program starts). */
  readonly vars = new Map<string, Variable>();
  readonly consts = new Map<string, ConstSlot>();
  readonly procs = new Map<string, ProcRef>();
  readonly enumMembers = new Map<string, ValueRef>();
  readonly enums = new Map<string, EnumRef>();
  readonly types = new Map<string, TypeDecl>();
  readonly ref: ModuleRef;
  initialized = false;

  constructor(readonly name: string, readonly kind: 'form' | 'module', readonly ast: ModuleAst) {
    this.key = lc(name);
    this.ref = new ModuleRef(this);
    for (const c of ast.consts) this.consts.set(lc(c.name), new ConstSlot(c, this));
    for (const p of ast.procedures) this.procs.set(lc(p.name), new ProcRef(this, p));
    for (const e of ast.enums) {
      const er = new EnumRef(e);
      this.enums.set(lc(e.name), er);
      for (const m of e.members) this.enumMembers.set(lc(m.name), new ValueRef(m.value));
    }
    for (const t of ast.types) this.types.set(lc(t.name), t);
  }

  get optionExplicit(): boolean { return this.ast.optionExplicit; }
}

/** Names visible from every module: Public items of standard modules. */
export class GlobalScope {
  readonly vars = new Map<string, Variable>();
  readonly consts = new Map<string, ConstSlot>();
  readonly procs = new Map<string, ProcRef>();
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

  constructor(
    readonly run: Run,
    readonly module: ModuleScope,
    readonly proc: ProcDecl | null,
    /** Line of the statement being executed. */
    public line: number,
  ) {}

  get rt(): Runtime { return this.run.rt; }

  location(): CodeLocation {
    return { moduleName: this.module.name, procName: this.proc?.name ?? '', line: this.line };
  }
}

/** One running event handler (or Immediate command): its call stack, innermost frame last. */
export class Run {
  readonly frames: Frame[] = [];
  constructor(readonly rt: Runtime) {}

  get top(): Frame | undefined { return this.frames[this.frames.length - 1]; }
}
