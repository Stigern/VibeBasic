// Run-time control objects: a ControlObject mirrors one control's properties and queues every change
// as a patch to the form window; a ControlArrayObject is the `Command1(i)` collection.

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, coerce, isObject, toBool, toStr, type VBValue } from '../../lang/values';
import { CONTROL_TYPES, getPropDef, type PropDef } from '../../model/controls';
import type { ControlDef, FontValue, PictureRef, PropValue } from '../../model/types';
import type { PatchQueue } from '../patchQueue';

export interface RunContext {
  resolveAsset(ref: PictureRef): string | null;
  loadPicture(path: string): Promise<VBValue>;
  /** A Timer's Enabled or Interval changed. */
  timerChanged(ctrl: ControlObject): void;
}

/** Any picture value (what LoadPicture returns, or what `Picture` reads) carries its asset reference. */
export interface HasPictureRef { pictureRef: PictureRef }
const hasPictureRef = (v: unknown): v is HasPictureRef =>
  typeof v === 'object' && v !== null && 'pictureRef' in v;

class PictureHandle implements VBObject, HasPictureRef {
  readonly vbTypeName = 'Picture';
  constructor(readonly pictureRef: PictureRef) {}
  hasMember(): boolean { return false; }
  getMember(): VBValue { throw new VBRuntimeError(438); }
  setMember(): void { throw new VBRuntimeError(438); }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

const FONT_PROPS: Record<string, keyof FontValue> = { name: 'name', size: 'size', bold: 'bold', italic: 'italic', underline: 'underline' };

class FontObject implements VBObject {
  readonly vbTypeName = 'Font';
  constructor(private get: () => FontValue, private set: (f: FontValue) => void) {}
  hasMember(name: string): boolean { return name.toLowerCase() in FONT_PROPS; }
  getMember(name: string): VBValue {
    const k = FONT_PROPS[name.toLowerCase()];
    if (!k) throw new VBRuntimeError(438);
    return this.get()[k];
  }
  setMember(name: string, _args: VBValue[], value: VBValue): void {
    const k = FONT_PROPS[name.toLowerCase()];
    if (!k) throw new VBRuntimeError(438);
    const f = { ...this.get() } as Record<string, string | number | boolean>;
    f[k] = k === 'name' ? toStr(value) : k === 'size' ? Number(coerce(value, 'Double')) : toBool(value);
    this.set(f as unknown as FontValue);
  }
  callMethod(): VBValue { throw new VBRuntimeError(438); }
}

const isListType = (t: string): boolean => t === 'ListBox' || t === 'ComboBox';
const num = (v: VBValue): number => coerce(v, 'Long') as number;
const badIndex = (): VBRuntimeError => new VBRuntimeError(381, 'Invalid property array index');

export class ControlObject implements VBObject {
  readonly vbTypeName: string;
  readonly defaultMember?: string;
  readonly props: Record<string, PropValue> = {};

  constructor(readonly def: ControlDef, private formKey: string, private queue: PatchQueue, private ctx: RunContext) {
    const td = CONTROL_TYPES[def.type];
    this.vbTypeName = def.type;
    this.defaultMember = td.defaultMember ?? undefined;
    for (const pd of td.props) this.props[pd.name] = Array.isArray(pd.default) ? [...pd.default] : pd.default;
    for (const [k, v] of Object.entries(def.props)) {
      const pd = getPropDef(def.type, k);
      this.props[pd?.name ?? k] = Array.isArray(v) ? [...v] : v;
    }
    if (isListType(def.type)) {
      this.props.ListIndex = -1; this.props.NewIndex = -1;
    }
  }

  get name(): string { return this.def.name; }
  get index(): number | null { return this.def.index; }

  /** State reported by the window (user input). Updates the mirror without sending a patch back. */
  applyState(props: Record<string, PropValue>): void {
    for (const [k, v] of Object.entries(props)) this.props[getPropDef(this.def.type, k)?.name ?? k] = v;
  }

  // -- VBObject ---------------------------------------------------------------------------------------------

  hasMember(name: string): boolean {
    const l = name.toLowerCase();
    if (l === 'name') return true;
    if (l === 'index') return this.def.index !== null;
    const pd = getPropDef(this.def.type, name);
    if (pd) return pd.runtime !== 'none';
    return CONTROL_TYPES[this.def.type].methods.some(m => m.name.toLowerCase() === l);
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (l === 'name') return this.def.name;
    if (l === 'index') {
      if (this.def.index === null) throw new VBRuntimeError(343, 'Object not an array');
      return this.def.index;
    }
    const pd = this.propDef(name);
    if (pd.kind === 'list') return this.getListItem(args);
    if (pd.name === 'Selected') return this.selected(args);
    if (args.length) throw new VBRuntimeError(450);
    const v = this.read(pd);
    if (pd.kind === 'font') return new FontObject(() => this.props.Font as FontValue, f => this.write(this.propDef('Font'), f));
    if (pd.kind === 'picture') return v ? new PictureHandle(v as PictureRef) : Nothing;
    return v as VBValue;
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const pd = this.propDef(name);
    if (pd.runtime === 'ro' || name.toLowerCase() === 'name' || name.toLowerCase() === 'index') throw new VBRuntimeError(383);
    if (pd.kind === 'list') {
      if (args.length !== 1) throw new VBRuntimeError(450);
      const i = num(args[0]);
      const list = this.list();
      if (i < 0 || i >= list.length) throw badIndex();
      list[i] = toStr(this.plain(value));
      this.send({ List: [...list] });
      return;
    }
    if (pd.name === 'Selected') {
      if (args.length !== 1) throw new VBRuntimeError(450);
      const i = num(args[0]);
      if (i < 0 || i >= this.list().length) throw badIndex();
      if (toBool(this.plain(value))) this.write(this.propDef('ListIndex'), i);
      else if (this.props.ListIndex === i) this.write(this.propDef('ListIndex'), -1);
      return;
    }
    if (args.length) throw new VBRuntimeError(450);
    this.write(pd, this.convert(pd, value));
  }

  callMethod(name: string, args: VBValue[]): VBValue {
    const l = name.toLowerCase();
    if (!CONTROL_TYPES[this.def.type].methods.some(m => m.name.toLowerCase() === l)) throw new VBRuntimeError(438);
    switch (l) {
      case 'move': return this.move(args);
      case 'setfocus': this.queue.send(this.formKey, { t: 'focus', id: this.def.id }); return Empty;
      case 'additem': return this.addItem(args);
      case 'removeitem': return this.removeItem(args);
      case 'clear': return this.clear();
      default: return Empty;   // Refresh, ZOrder: nothing to do in the renderer
    }
  }

  // -- properties -------------------------------------------------------------------------------------------

  private propDef(name: string): PropDef {
    const pd = getPropDef(this.def.type, name);
    if (!pd || pd.runtime === 'none') {
      const l = name.toLowerCase();
      if (l === 'name') return { name: 'Name', kind: 'string', default: '', designTime: false, runtime: 'ro' };
      if (l === 'index') return { name: 'Index', kind: 'int', default: 0, designTime: false, runtime: 'ro' };
      throw new VBRuntimeError(438);
    }
    return pd;
  }

  private list(): string[] { return this.props.List as string[]; }

  /** Current value of a property, including the computed ones. */
  private read(pd: PropDef): PropValue {
    switch (pd.name) {
      case 'ListCount': return this.list().length;
      case 'Text':
        if (this.def.type === 'ListBox') {
          const i = this.props.ListIndex as number;
          return i >= 0 ? this.list()[i] ?? '' : '';
        }
        break;
      case 'SelText': {
        const t = String(this.props.Text ?? ''), s = Number(this.props.SelStart), n = Number(this.props.SelLength);
        return t.substr(s, n);
      }
      case 'Name': return this.def.name;
    }
    return this.props[pd.name];
  }

  private selected(args: VBValue[]): VBValue {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(args[0]);
    if (i < 0 || i >= this.list().length) throw badIndex();
    return this.props.ListIndex === i;
  }

  private getListItem(args: VBValue[]): VBValue {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(args[0]);
    const list = this.list();
    if (i < 0 || i >= list.length) throw badIndex();
    return list[i];
  }

  /** An object value becomes its default member's value (`Form1.Text1 = Text2`). */
  private plain(v: VBValue): VBValue {
    for (let n = 0; n < 4 && isObject(v) && !hasPictureRef(v); n++) {
      if (!v.defaultMember) throw new VBRuntimeError(13);
      v = v.getMember(v.defaultMember, []);
    }
    return v;
  }

  private convert(pd: PropDef, value: VBValue): PropValue {
    if (pd.kind === 'picture') {
      if (value === Nothing || value === Empty) return null;
      const v = this.plain(value);
      if (hasPictureRef(v)) return v.pictureRef;
      if (v === Nothing || v === Empty) return null;
      throw new VBRuntimeError(13);
    }
    if (pd.kind === 'font') throw new VBRuntimeError(13);
    const v = this.plain(value);
    switch (pd.kind) {
      case 'string': case 'text': return toStr(v);
      case 'bool': return toBool(v);
      case 'color': return num(v);
      case 'enum': {
        const n = num(v);
        if (!pd.enumValues?.some(e => e.value === n)) throw new VBRuntimeError(380);
        return n;
      }
      case 'int': {
        const n = num(v);
        if (pd.min !== undefined && n < pd.min) throw new VBRuntimeError(380);
        if (pd.max !== undefined && n > pd.max) throw new VBRuntimeError(380);
        if (pd.name === 'Value' && 'Min' in this.props && 'Max' in this.props
          && (n < Number(this.props.Min) || n > Number(this.props.Max))) throw new VBRuntimeError(380);
        if (pd.name === 'ListIndex' && (n < -1 || n > this.list().length - 1)) throw new VBRuntimeError(380);
        return n;
      }
    }
    throw new VBRuntimeError(13);
  }

  /** Store a converted value, apply side effects, queue the patch and notify the timer owner. */
  private write(pd: PropDef, v: PropValue): void {
    const patch: Record<string, PropValue> = {};
    const name = pd.name;
    if (name === 'SelText') {
      const t = String(this.props.Text ?? ''), s = Number(this.props.SelStart), n = Number(this.props.SelLength);
      const ins = String(v);
      this.props.Text = t.slice(0, s) + ins + t.slice(s + n);
      this.props.SelStart = s + ins.length; this.props.SelLength = 0;
      Object.assign(patch, { Text: this.props.Text, SelStart: this.props.SelStart, SelLength: 0 });
    } else {
      this.props[name] = v;
      patch[name] = v;
      if (name === 'ListIndex') {
        const i = v as number;
        if (this.def.type === 'ComboBox') { this.props.Text = i >= 0 ? this.list()[i] : ''; patch.Text = this.props.Text; }
      } else if (name === 'Text' && this.def.type === 'ComboBox') {
        const i = this.list().findIndex(s => s === v);
        this.props.ListIndex = i; patch.ListIndex = i;
      }
    }
    this.send(patch);
    if (this.def.type === 'Timer' && (name === 'Enabled' || name === 'Interval')) this.ctx.timerChanged(this);
  }

  private send(props: Record<string, PropValue>): void {
    if (this.def.type === 'Timer') return;   // no view
    this.queue.set(this.formKey, this.def.id, props);
  }

  // -- methods ----------------------------------------------------------------------------------------------

  private move(args: VBValue[]): VBValue {
    if (args.length < 1 || args.length > 4) throw new VBRuntimeError(450);
    const patch: Record<string, PropValue> = {};
    ['Left', 'Top', 'Width', 'Height'].forEach((k, i) => {
      const a = args[i];
      if (a === undefined || a === Empty) return;
      patch[k] = this.props[k] = num(this.plain(a));
    });
    this.send(patch);
    return Empty;
  }

  private addItem(args: VBValue[]): VBValue {
    if (args.length < 1 || args.length > 2) throw new VBRuntimeError(450);
    const item = toStr(this.plain(args[0]));
    const list = this.list();
    let at = list.length;
    if (this.props.Sorted) {
      const key = item.toLowerCase();
      at = list.findIndex(s => s.toLowerCase() > key);
      if (at < 0) at = list.length;
    } else if (args.length === 2) {
      at = num(this.plain(args[1]));
      if (at < 0 || at > list.length) throw new VBRuntimeError(5);
    }
    list.splice(at, 0, item);
    this.props.NewIndex = at;
    const patch: Record<string, PropValue> = { List: [...list] };
    const li = this.props.ListIndex as number;
    if (li >= at) { this.props.ListIndex = li + 1; patch.ListIndex = li + 1; }
    this.send(patch);
    return Empty;
  }

  private removeItem(args: VBValue[]): VBValue {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = num(this.plain(args[0]));
    const list = this.list();
    if (i < 0 || i >= list.length) throw new VBRuntimeError(5);
    list.splice(i, 1);
    const patch: Record<string, PropValue> = { List: [...list] };
    const li = this.props.ListIndex as number;
    if (li === i) { this.props.ListIndex = -1; patch.ListIndex = -1; }
    else if (li > i) { this.props.ListIndex = li - 1; patch.ListIndex = li - 1; }
    this.send(patch);
    return Empty;
  }

  private clear(): VBValue {
    this.props.List = [];
    this.props.ListIndex = -1;
    this.props.NewIndex = -1;
    const patch: Record<string, PropValue> = { List: [], ListIndex: -1 };
    if (this.def.type === 'ComboBox') { this.props.Text = ''; patch.Text = ''; }
    this.send(patch);
    return Empty;
  }
}

/** `Command1(i)`: the controls sharing one name, addressed by Index. */
export class ControlArrayObject implements VBObject {
  readonly vbTypeName = 'Object';
  private members = new Map<number, ControlObject>();

  constructor(readonly name: string, controls: ControlObject[] = []) {
    for (const c of controls) this.add(c);
  }

  add(c: ControlObject): void { this.members.set(c.index ?? 0, c); }
  remove(index: number): void { this.members.delete(index); }

  private sorted(): ControlObject[] { return [...this.members.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]); }

  item(i: number): ControlObject {
    const c = this.members.get(i);
    if (!c) throw new VBRuntimeError(340, `Control array element '${i}' doesn't exist`);
    return c;
  }

  items(): VBObject[] { return this.sorted(); }

  hasMember(name: string): boolean { return ['count', 'lbound', 'ubound'].includes(name.toLowerCase()); }

  getMember(name: string, args: VBValue[]): VBValue {
    if (args.length) throw new VBRuntimeError(450);
    const idx = [...this.members.keys()];
    switch (name.toLowerCase()) {
      case 'count': return idx.length;
      case 'lbound': return idx.length ? Math.min(...idx) : 0;
      case 'ubound': return idx.length ? Math.max(...idx) : -1;
    }
    throw new VBRuntimeError(438);
  }

  setMember(name: string): void {
    if (this.hasMember(name)) throw new VBRuntimeError(383);
    throw new VBRuntimeError(438);
  }

  callMethod(): VBValue { throw new VBRuntimeError(438); }
}
