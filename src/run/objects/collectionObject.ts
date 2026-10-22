// The VB6 collection shared by Panels, Tabs (and Nodes, ListItems, ColumnHeaders): 1-based, items optionally keyed
// (case-insensitive), `Item` is the default member, `For Each` goes through items().
//
// How a collection is made:
//   new CollectionObject<T>('Panels', factory, onChange)
// - `factory(args)` receives the VB arguments of `Add(...)` (omitted ones are `undefined`; objects with a default member
//   are already plain values) and returns `{ item, at? }`: the new item and, when the call names a position
//   (Add's Index / Before), its 1-based position (`at` 1..Count+1; absent = append). Argument handling is the
//   factory's business, so each collection has its own Add signature. Errors from it (e.g. 5, 450) are thrown as VB errors.
// - `onChange(kind, item, at)` is told after every change made through the collection or an item
//   ('add' | 'remove' | 'clear' | 'item'); `at` is the 1-based position the item had/has (0 for 'clear').
//   The owner (a ControlObject) answers with a patch.
// - items get `index` (1-based, kept up to date) and `owner`; `ItemObject` below is a ready-made item with
//   case-insensitive fields (Text, Key, Tag …) that reports changes; subclass it for computed members.
// Errors: 35600 for an unknown index or key, 35602 for a key that is already used.

import { VBRuntimeError } from '../../lang/errors';
import type { VBObject } from '../../lang/host';
import { Empty, coerce, isObject, toBool, toStr, type VBValue } from '../../lang/values';

export interface CollectionItem extends VBObject {
  readonly key: string;
  /** 1-based position; set by the collection. */
  index: number;
  owner: CollectionObject<CollectionItem> | null;
}
export type ChangeKind = 'add' | 'remove' | 'clear' | 'item';
export type AddResult<T> = { item: T; at?: number };

const lc = (s: string): string => s.toLowerCase();

/** An object value becomes its default member's value (up to a few levels). */
export function plainValue(v: VBValue): VBValue {
  for (let n = 0; n < 4 && isObject(v); n++) {
    if (v.defaultMember === undefined) throw new VBRuntimeError(13);
    v = v.getMember(v.defaultMember, []);
  }
  return v;
}
const given = (v: VBValue | undefined): v is VBValue => v !== undefined && v !== Empty;

/** Helpers for factories: an optional argument as a string / position. */
export const optString = (v: VBValue | undefined): string => (given(v) ? toStr(plainValue(v)) : '');
export const optPosition = (v: VBValue | undefined): number | undefined => (given(v) ? (coerce(plainValue(v), 'Long') as number) : undefined);

export class CollectionObject<T extends CollectionItem> implements VBObject {
  readonly defaultMember = 'Item';
  private list: T[] = [];

  constructor(readonly vbTypeName: string,
    private factory: (args: VBValue[]) => AddResult<T>,
    private onChange: (kind: ChangeKind, item: T | null, at: number) => void = () => {}) {}

  get count(): number { return this.list.length; }
  /** For Each, and the owner's serialization. */
  items(): T[] { return [...this.list]; }

  /** By 1-based index or key; undefined when there is none. */
  find(indexOrKey: VBValue): T | undefined {
    const v = plainValue(indexOrKey);
    if (typeof v === 'string') {
      const k = lc(v);
      return k === '' ? undefined : this.list.find(i => lc(i.key) === k);
    }
    const n = coerce(v, 'Long') as number;
    return this.list[n - 1];
  }
  /** As `find`, but an unknown index or key is error 35600. */
  get(indexOrKey: VBValue): T {
    const i = this.find(indexOrKey);
    if (!i) throw new VBRuntimeError(35600);
    return i;
  }

  /** Seeds an item without telling the owner (design-time Panels/Tabs at start-up). */
  append(item: T): T {
    this.checkKey(item.key, item);
    this.attach(item, this.list.length + 1);
    return item;
  }

  /** Error 35602 when `key` belongs to another item. */
  checkKey(key: string, except: T | null): void {
    const k = lc(key);
    if (k !== '' && this.list.some(i => i !== except && lc(i.key) === k)) throw new VBRuntimeError(35602);
  }

  /** Called by an item whose field changed. */
  itemChanged(item: T, _field: string): void { this.onChange('item', item, item.index); }

  private attach(item: T, at: number): void {
    this.list.splice(at - 1, 0, item);
    item.owner = this as unknown as CollectionObject<CollectionItem>;
    this.list.forEach((x, i) => { x.index = i + 1; });
  }

  add(args: VBValue[]): T {
    const { item, at } = this.factory(args);
    if (at !== undefined && (at < 1 || at > this.list.length + 1)) throw new VBRuntimeError(35600);
    this.checkKey(item.key, null);
    this.attach(item, at ?? this.list.length + 1);
    this.onChange('add', item, item.index);
    return item;
  }

  remove(indexOrKey: VBValue): void {
    const item = this.get(indexOrKey);
    const at = item.index;
    this.list.splice(at - 1, 1);
    item.owner = null;
    this.list.forEach((x, i) => { x.index = i + 1; });
    this.onChange('remove', item, at);
  }

  clear(): void {
    for (const i of this.list) i.owner = null;
    this.list = [];
    this.onChange('clear', null, 0);
  }

  // -- VBObject ---------------------------------------------------------------------------------------------

  hasMember(name: string): boolean { return ['count', 'item'].includes(lc(name)); }

  getMember(name: string, args: VBValue[]): VBValue {
    switch (lc(name)) {
      case 'count':
        if (args.length) throw new VBRuntimeError(450);
        return this.list.length;
      case 'item':
        if (args.length !== 1 || !given(args[0])) throw new VBRuntimeError(450);
        return this.get(args[0]);
      case 'add': return this.add(args);          // `x = Coll.Add` without parentheses
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string): void {
    throw new VBRuntimeError(this.hasMember(name) ? 383 : 438);
  }

  callMethod(name: string, args: VBValue[]): VBValue {
    switch (lc(name)) {
      case 'add': return this.add(args);
      case 'remove':
        if (args.length !== 1 || !given(args[0])) throw new VBRuntimeError(450);
        this.remove(args[0]);
        return Empty;
      case 'clear':
        if (args.length) throw new VBRuntimeError(450);
        this.clear();
        return Empty;
    }
    throw new VBRuntimeError(438);
  }
}

// ---------------------------------------------------------------------------------------------------------------

export type FieldKind = 'string' | 'long' | 'bool' | 'any';
export interface FieldDef { name: string; kind: FieldKind; readOnly?: boolean }

/** An item with named fields (`Key` is the item's key; `Index` is built in and read-only). Changes go to the owner. */
export class ItemObject implements CollectionItem {
  index = 0;
  owner: CollectionObject<CollectionItem> | null = null;
  private values = new Map<string, VBValue>();
  private defs = new Map<string, FieldDef>();

  constructor(readonly vbTypeName: string, readonly defaultMember: string, fields: FieldDef[], init: Record<string, VBValue> = {}) {
    for (const f of fields) {
      this.defs.set(lc(f.name), f);
      this.values.set(lc(f.name), f.kind === 'string' ? '' : f.kind === 'long' ? 0 : f.kind === 'bool' ? false : Empty);
    }
    for (const [k, v] of Object.entries(init)) if (v !== undefined && this.defs.has(lc(k))) this.values.set(lc(k), v);
  }

  get key(): string { return String(this.values.get('key') ?? ''); }

  /** Raw field access for the owner (no change notification). */
  field(name: string): VBValue { return this.values.get(lc(name)) ?? Empty; }

  hasMember(name: string): boolean { return lc(name) === 'index' || this.defs.has(lc(name)); }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = lc(name);
    if (!this.hasMember(name)) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    return l === 'index' ? this.index : this.values.get(l)!;
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const l = lc(name), f = this.defs.get(l);
    if (l === 'index') throw new VBRuntimeError(383);
    if (!f) throw new VBRuntimeError(438);
    if (args.length) throw new VBRuntimeError(450);
    if (f.readOnly) throw new VBRuntimeError(383);
    let v: VBValue;
    switch (f.kind) {
      case 'string': v = toStr(plainValue(value)); break;
      case 'long': v = coerce(plainValue(value), 'Long') as number; break;
      case 'bool': v = toBool(plainValue(value)); break;
      default: v = value;
    }
    if (l === 'key') this.owner?.checkKey(v as string, this);
    this.values.set(l, v);
    this.owner?.itemChanged(this, f.name);
  }

  callMethod(): VBValue { throw new VBRuntimeError(438); }
}
