// Run-time collections and the Clipboard: `Controls` (Me.Controls) and `Forms` as VB6 has them (0-based Item, Count,
// For Each), and the Clipboard object (text only; the system clipboard through the form host, a private copy when
// that cannot be reached).

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, coerce, isObject, toStr, type VBValue } from '../../lang/values';

const lc = (s: string): string => s.toLowerCase();

/**
 * A read-only list of objects: Count, Item(i) (0-based, as VB6's Controls and Forms) or Item("name"), and For Each.
 * `list` is asked on every use, so the collection is live (a control loaded later, a form unloaded).
 */
export class ObjectList implements VBObject {
  readonly defaultMember = 'Item';
  constructor(readonly vbTypeName: string, private list: () => VBObject[], private nameOf: (o: VBObject) => string,
    private notFound: (name: string) => VBRuntimeError) {}

  items(): VBObject[] { return this.list(); }

  hasMember(name: string): boolean { return lc(name) === 'count' || lc(name) === 'item'; }

  getMember(name: string, args: VBValue[]): VBValue {
    switch (lc(name)) {
      case 'count':
        if (args.length) throw new VBRuntimeError(450);
        return this.list().length;
      case 'item':
        if (args.length !== 1) throw new VBRuntimeError(450);
        return this.at(args[0]);
    }
    throw new VBRuntimeError(438);
  }

  private at(v: VBValue): VBObject {
    const list = this.list();
    let key = v;
    while (isObject(key) && key.defaultMember) key = key.getMember(key.defaultMember, []);
    if (typeof key === 'string') {
      const o = list.find(x => lc(this.nameOf(x)) === lc(key as string));
      if (!o) throw this.notFound(key);
      return o;
    }
    const i = coerce(key, 'Long') as number;
    if (i < 0 || i >= list.length) throw new VBRuntimeError(9);
    return list[i];
  }

  setMember(name: string): void { throw new VBRuntimeError(this.hasMember(name) ? 383 : 438); }

  callMethod(name: string, args: VBValue[]): VBValue {
    if (lc(name) === 'item') return this.getMember(name, args);
    throw new VBRuntimeError(438);
  }
}

/** The system clipboard as the host offers it (text only). */
export interface ClipboardApi {
  getText(): Promise<string>;
  setText(text: string): Promise<void>;
}

/** vbCFText; the other formats (vbCFBitmap, vbCFRTF ...) are not supported. */
const CF_TEXT = 1;
const CLIPBOARD_METHODS = new Set(['gettext', 'settext', 'clear', 'getformat', 'getdata', 'setdata']);

/**
 * Clipboard: GetText, SetText text, Clear and GetFormat(vbCFText). Pictures (GetData / SetData) give 438.
 * When the system clipboard cannot be reached the program still sees what it put there itself.
 */
export class ClipboardObject implements VBObject {
  readonly vbTypeName = 'Clipboard';
  private local = '';

  constructor(private api: () => ClipboardApi | undefined) {}

  hasMember(): boolean { return false; }

  /** `x = Clipboard.GetText` (no parentheses) comes here; the interpreter waits for the Promise. */
  getMember(name: string, args: VBValue[]): VBValue {
    if (CLIPBOARD_METHODS.has(lc(name))) return this.callMethod(name, args) as unknown as VBValue;
    throw new VBRuntimeError(438);
  }

  setMember(): void { throw new VBRuntimeError(438); }

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const format = (i: number): number => (args[i] === undefined || args[i] === Empty ? CF_TEXT : coerce(args[i], 'Long') as number);
    switch (lc(name)) {
      case 'gettext':
        if (args.length > 1) throw new VBRuntimeError(450);
        return format(0) === CF_TEXT ? this.read() : '';
      case 'settext': {
        if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
        if (format(1) !== CF_TEXT) throw new VBRuntimeError(461, 'Specified format doesn\'t match format of data');
        return this.write(toStr(args[0])).then(() => Empty);
      }
      case 'clear':
        if (args.length) throw new VBRuntimeError(450);
        return this.write('').then(() => Empty);
      case 'getformat':
        if (args.length !== 1) throw new VBRuntimeError(450);
        return format(0) === CF_TEXT ? this.read().then(t => t !== '') : false;
    }
    throw new VBRuntimeError(438);
  }

  private async read(): Promise<string> {
    const api = this.api();
    if (!api) return this.local;
    try {
      return this.local = await api.getText();
    } catch {
      return this.local;
    }
  }

  private async write(text: string): Promise<void> {
    this.local = text;
    try {
      await this.api()?.setText(text);
    } catch { /* the program's own copy stays */ }
  }
}
