// DataObject (OLE drag and drop, 0.9 B4): the data a drag carries, by clipboard format (vbCFText 1, vbCFBitmap 2, vbCFFiles 15 ...),
// and its Files collection (the paths of files dropped from Finder). A format declared with SetData and no value is asked from the
// drag's source when the target reads it (OLESetData).

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, coerce, isObject, toStr, type VBValue } from '../../lang/values';

const CF_TEXT = 1, CF_BITMAP = 2, CF_FILES = 15;
const lc = (s: string): string => s.toLowerCase();
const given = (v: VBValue | undefined): v is VBValue => v !== undefined && v !== Empty;
const badFormat = (): VBRuntimeError => new VBRuntimeError(461, 'Specified format doesn\'t match format of data');

/** DataObject.Files: Count, Item(i) (1-based), Add(path, [index]), Remove(index), Clear and For Each. */
export class DataObjectFiles implements VBObject {
  readonly vbTypeName = 'DataObjectFiles';
  readonly defaultMember = 'Item';
  list: string[] = [];

  items(): VBObject[] { return [...this.list] as unknown as VBObject[]; }   // For Each gives the path strings

  hasMember(name: string): boolean { return ['count', 'item', 'add', 'remove', 'clear'].includes(lc(name)); }

  private index(v: VBValue, extra = 0): number {
    const i = coerce(v, 'Long') as number;
    if (i < 1 || i > this.list.length + extra) throw new VBRuntimeError(9);
    return i - 1;
  }

  getMember(name: string, args: VBValue[]): VBValue {
    if (lc(name) === 'count') { if (args.length) throw new VBRuntimeError(450); return this.list.length; }
    return this.callMethod(name, args);
  }

  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }

  callMethod(name: string, args: VBValue[]): VBValue {
    switch (lc(name)) {
      case 'item':
        if (args.length !== 1) throw new VBRuntimeError(450);
        return this.list[this.index(args[0])];
      case 'add':
        if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
        this.list.splice(given(args[1]) ? this.index(args[1], 1) : this.list.length, 0, toStr(args[0]));
        return Empty;
      case 'remove':
        if (args.length !== 1) throw new VBRuntimeError(450);
        this.list.splice(this.index(args[0]), 1);
        return Empty;
      case 'clear': this.list = []; return Empty;
      case 'count': return this.list.length;
    }
    throw new VBRuntimeError(438);
  }
}

export class DataObject implements VBObject {
  readonly vbTypeName = 'DataObject';
  readonly rawArgs = true;   // SetData keeps a Picture object as it is
  readonly files = new DataObjectFiles();
  /** Format -> data; undefined: declared by SetData without a value (the source gives it in OLESetData). */
  private data = new Map<number, VBValue | undefined>();

  /** `request`: the target reads a declared format that has no data yet (the source's OLESetData runs). */
  constructor(private request?: (format: number) => Promise<void>) {}

  /** The text of the drag (vbCFText), or null. */
  text(): string | null { const v = this.data.get(CF_TEXT); return given(v) ? toStr(v) : null; }
  /** The picture of the drag (vbCFBitmap), or null. */
  picture(): VBValue | null { const v = this.data.get(CF_BITMAP); return given(v) ? v : null; }

  hasFormat(format: number): boolean { return format === CF_FILES ? this.files.list.length > 0 || this.data.has(CF_FILES) : this.data.has(format); }

  set(value: VBValue, format: number): void { this.data.set(format, value); }

  hasMember(name: string): boolean { return ['getdata', 'getformat', 'setdata', 'clear', 'files'].includes(lc(name)); }

  getMember(name: string, args: VBValue[]): VBValue {
    if (lc(name) === 'files') return args.length ? this.files.callMethod('Item', args) : this.files;
    if (this.hasMember(name)) return this.callMethod(name, args) as VBValue;   // `x = Data.GetData(vbCFText)`; a Promise is awaited
    throw new VBRuntimeError(438);
  }

  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const plain = (v: VBValue): VBValue => (isObject(v) && v.defaultMember && !('pictureRef' in v) ? v.getMember(v.defaultMember, []) : v);
    const format = (v: VBValue | undefined, d: number): number => (given(v) ? coerce(plain(v), 'Long') as number : d);
    switch (lc(name)) {
      case 'getformat':
        if (args.length !== 1) throw new VBRuntimeError(450);
        return this.hasFormat(format(args[0], CF_TEXT));
      case 'getdata': {
        if (args.length > 1) throw new VBRuntimeError(450);
        const f = format(args[0], CF_TEXT);
        if (f === CF_FILES || !this.data.has(f)) throw badFormat();   // the paths are in Files
        if (given(this.data.get(f)) || !this.request) return this.data.get(f) ?? Empty;
        return this.request(f).then(() => this.data.get(f) ?? Empty);
      }
      case 'setdata': {
        if (args.length > 2) throw new VBRuntimeError(450);
        const v = given(args[0]) ? plain(args[0]) : undefined;
        if (v === undefined && !given(args[1])) throw new VBRuntimeError(5);
        const f = format(args[1], v !== undefined && isObject(v) ? CF_BITMAP : CF_TEXT);
        if (f === CF_FILES && v !== undefined) throw badFormat();   // Files.Add puts paths in
        this.data.set(f, v === undefined ? undefined : typeof v === 'string' || isObject(v) ? v : toStr(v));
        return Empty;
      }
      case 'clear':
        if (args.length) throw new VBRuntimeError(450);
        this.data.clear();
        this.files.list = [];
        return Empty;
    }
    throw new VBRuntimeError(438);
  }
}
