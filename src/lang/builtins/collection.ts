// VB's Collection object (`Dim c As New Collection`, `Set c = New Collection`): an ordered list of values with
// optional string keys (case-insensitive).
//
// - `Add item, [key], [before], [after]`: before/after are a 1-based position or a key; giving both, or one that does
//   not exist, is error 5. A key that is already used is error 457; a key that is not a string is error 13.
// - `Item(index | key)` (the default member, so `c(1)`, `c("k")` and `c!k` work), `Count`, `Remove index | key`.
//   An index out of range is error 9, an unknown key error 5.
// - `For Each` visits the items in order. Items are read-only (`c(1) = x` is error 424 for a value, as in VB6).
// - Objects are kept as references (an object argument is not turned into its default member: `rawArgs`).

import { VBRuntimeError } from '../errors';
import type { VBObject } from '../host';
import type { BuiltinCtx } from './util';
import { Empty, EmptyT, VBArray, VBRecord, isObject, toNumber, type VBValue } from '../values';

interface Entry { value: VBValue; key: string | null }

const given = (v: VBValue | undefined): v is VBValue => v !== undefined && !(v instanceof EmptyT);

export class VBCollection implements VBObject {
  readonly vbTypeName = 'Collection';
  readonly defaultMember = 'Item';
  /** Arguments reach `callMethod` as they are (an object stays an object). */
  readonly rawArgs = true;
  private list: Entry[] = [];

  /** For Each. */
  items(): VBObject[] { return this.list.map(e => e.value) as VBObject[]; }

  /** 0-based position of an index or key argument; `missing` is the error for a key that is not there. */
  private position(at: VBValue, missing: number): number {
    if (typeof at === 'string') {
      const k = at.toLowerCase();
      const i = this.list.findIndex(e => e.key === k);
      if (i < 0) throw new VBRuntimeError(missing);
      return i;
    }
    const n = Math.round(toNumber(isObject(at) && at.defaultMember !== undefined ? at.getMember(at.defaultMember, []) : at));
    if (!(n >= 1 && n <= this.list.length)) throw new VBRuntimeError(9);
    return n - 1;
  }

  private add(args: VBValue[]): void {
    const [item, key, before, after] = args;
    if (item === undefined) throw new VBRuntimeError(450);
    let k: string | null = null;
    if (given(key)) {
      if (typeof key !== 'string') throw new VBRuntimeError(13);
      k = key.toLowerCase();
      if (this.list.some(e => e.key === k)) throw new VBRuntimeError(457);
    }
    if (given(before) && given(after)) throw new VBRuntimeError(5);
    let at = this.list.length;
    if (given(before)) at = this.position(before, 5);
    else if (given(after)) at = this.position(after, 5) + 1;
    const value = item instanceof VBArray || item instanceof VBRecord ? item.clone() : item;
    this.list.splice(at, 0, { value, key: k });
  }

  hasMember(name: string): boolean {
    const n = name.toLowerCase();
    return n === 'item' || n === 'count';
  }

  getMember(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'count':
        if (args.length) throw new VBRuntimeError(450);
        return this.list.length;
      case 'item':
        if (args.length !== 1 || !given(args[0])) throw new VBRuntimeError(450);
        return this.list[this.position(args[0], 5)].value;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string): void {
    throw new VBRuntimeError(this.hasMember(name) ? 424 : 438);
  }

  callMethod(name: string, args: VBValue[]): VBValue {
    switch (name.toLowerCase()) {
      case 'add':
        if (args.length > 4) throw new VBRuntimeError(450);
        this.add(args);
        return Empty;
      case 'remove':
        if (args.length !== 1 || !given(args[0])) throw new VBRuntimeError(450);
        this.list.splice(this.position(args[0], 5), 1);
        return Empty;
      case 'item': case 'count':
        return this.getMember(name, args);
    }
    throw new VBRuntimeError(438);
  }
}

// ---------------------------------------------------------------------------
// Classes New can make without a class module
// ---------------------------------------------------------------------------

/**
 * A class `New T` (and `Dim x As New T`) can make that is not a class module of the project. `create` gets the program's
 * built-in context (its host, for classes that need native services). Register more with `defClass`.
 */
export interface BuiltinClass { name: string; create(ctx: BuiltinCtx): VBObject }

/** Built-in classes by lower-case name; a library-qualified name (`vba.collection`) is a key of its own. */
export const BUILTIN_CLASSES = new Map<string, BuiltinClass>();

/** Registers a built-in class under each of `names` (the first is its display name). */
export function defClass(names: string[], create: (ctx: BuiltinCtx) => VBObject): void {
  const c: BuiltinClass = { name: names[0], create };
  for (const n of names) BUILTIN_CLASSES.set(n.toLowerCase(), c);
}

defClass(['Collection', 'VBA.Collection'], () => new VBCollection());
