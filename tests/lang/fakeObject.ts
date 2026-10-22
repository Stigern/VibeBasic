// A minimal VBObject for interpreter tests: named properties (case-insensitive
// lookup, stored under the name given in the constructor), child objects
// (`Form1.Text1`, `Text1.Font`), a control-array `item(i)` and `items()`, and methods that log
// their calls. Unknown members are error 438, a missing item is error 340.

import type { VBObject } from '../../src/lang/host';
import { VBRuntimeError } from '../../src/lang/errors';
import { toStr, type VBValue } from '../../src/lang/values';

export interface FakeOptions {
  defaultMember?: string;
  props?: Record<string, VBValue>;
  children?: Record<string, FakeObject>;
  /** Control array elements by index (sparse). */
  items?: Record<number, FakeObject>;
  /** Extra methods; the result may be a Promise. */
  methods?: Record<string, (args: VBValue[]) => VBValue | Promise<VBValue>>;
}

export class FakeObject implements VBObject {
  readonly defaultMember?: string;
  readonly props: Record<string, VBValue>;
  readonly children: Record<string, FakeObject>;
  /** Control array elements by index (sparse). */
  readonly elements: Record<number, FakeObject>;
  /** `AddItem:x`, `Unload`, `Load`, `get:Name`, `set:Name=value` … in call order. */
  readonly log: string[] = [];
  /** When true, getMember/setMember are logged too. */
  logAccess = false;
  private readonly methods: Record<string, (args: VBValue[]) => VBValue | Promise<VBValue>>;
  item?: (index: number) => VBObject;
  items?: () => VBObject[];

  constructor(readonly vbTypeName = 'TextBox', opts: FakeOptions = {}) {
    this.defaultMember = 'defaultMember' in opts ? opts.defaultMember : 'Text';
    this.props = opts.props ?? { Text: '', Caption: '' };
    this.children = opts.children ?? {};
    this.elements = opts.items ?? {};
    this.methods = opts.methods ?? {};
    if (opts.items) {
      this.item = (i: number) => {
        const it = this.elements[i];
        if (!it) throw new VBRuntimeError(340);
        return it;
      };
      this.items = () => Object.keys(this.elements).map(Number).sort((a, b) => a - b).map(i => this.elements[i]);
    }
  }

  private propKey(name: string): string | undefined {
    const n = name.toLowerCase();
    return Object.keys(this.props).find(k => k.toLowerCase() === n);
  }

  private child(name: string): FakeObject | undefined {
    const n = name.toLowerCase();
    const k = Object.keys(this.children).find(c => c.toLowerCase() === n);
    return k === undefined ? undefined : this.children[k];
  }

  hasMember(name: string): boolean {
    return this.propKey(name) !== undefined || this.child(name) !== undefined;
  }

  getMember(name: string, args: VBValue[]): VBValue {
    if (this.logAccess) this.log.push(`get:${name}${args.length ? `(${args.map(a => toStr(a)).join(',')})` : ''}`);
    const c = this.child(name);
    if (c) return c;
    const k = this.propKey(name);
    if (k === undefined) throw new VBRuntimeError(438);
    const v = this.props[k];
    if (args.length > 0) {
      if (!Array.isArray(v)) throw new VBRuntimeError(438);
      return (v as VBValue[])[Number(args[0])];
    }
    return v;
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (this.logAccess) this.log.push(`set:${name}=${typeof value === 'object' ? 'object' : toStr(value)}`);
    const k = this.propKey(name);
    if (k === undefined) throw new VBRuntimeError(438);
    if (args.length > 0) {
      (this.props[k] as unknown as VBValue[])[Number(args[0])] = value;
      return;
    }
    this.props[k] = value;
  }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const n = name.toLowerCase();
    const m = Object.keys(this.methods).find(k => k.toLowerCase() === n);
    if (m) {
      this.log.push(m);
      return this.methods[m](args);
    }
    switch (n) {
      case 'additem': this.log.push(`AddItem:${args.map(a => toStr(a)).join(',')}`); return 0;
      case 'unload': this.log.push('Unload'); return 0;
      case 'load': this.log.push('Load'); return 0;
    }
    throw new VBRuntimeError(438);
  }
}
