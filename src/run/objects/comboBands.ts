// The run-time side of ImageCombo (ComboItems, SelectedItem, Text) and CoolBar (Bands, Child, HeightChanged). Both keep their items as lines for the
// window (model/imageCombo.ts, model/coolbar.ts), like Toolbar's Buttons.

import { VBRuntimeError } from '../../lang/errors';
import { Nothing, VBRef, toBool, toStr, type VBValue } from '../../lang/values';
import { type BandData, bandLine, coolbarHeight, parseBand } from '../../model/coolbar';
import { comboItemLine, parseComboItem } from '../../model/imageCombo';
import { twipsToPx } from '../../model/twips';
import type { PropValue } from '../../model/types';
import { CollectionObject, ItemObject, optPosition, optString, plainValue, type ChangeKind } from './collectionObject';
import type { RichControl, RichHost } from './richControl';

const lc = (s: string): string => s.toLowerCase();

/** A control object of the form (not imported as a class: controlObject.ts imports this file). */
interface CtlLike { def: { name: string; type: string }; props: Record<string, PropValue> }
const asControl = (v: unknown): CtlLike | undefined => (typeof v === 'object' && v !== null && 'def' in v && 'props' in v ? v as CtlLike : undefined);

// -- ImageCombo ---------------------------------------------------------------------------------------------------

/** A ComboItem: Text (default), Key, Image and SelImage (index or key of the ImageList), Indentation, Tag, Index, Selected. */
class ComboItem extends ItemObject {
  constructor(init: { Text?: string; Key?: string; Image?: string; SelImage?: string; Indentation?: number }, private sel: { is(i: ComboItem): boolean; pick(i: ComboItem): void }) {
    super('ComboItem', 'Text', [
      { name: 'Text', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Image', kind: 'string' }, { name: 'SelImage', kind: 'string' },
      { name: 'Indentation', kind: 'long' }, { name: 'Tag', kind: 'any' },
    ], { ...init });
  }
  hasMember(name: string): boolean { return lc(name) === 'selected' || super.hasMember(name); }
  getMember(name: string, args: VBValue[]): VBValue { return lc(name) === 'selected' ? this.sel.is(this) : super.getMember(name, args); }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (lc(name) !== 'selected') {
      if (lc(name) === 'indentation' && Number(plainValue(value)) < 0) throw new VBRuntimeError(380);
      super.setMember(name, args, value);
      return;
    }
    if (toBool(plainValue(value))) this.sel.pick(this);
  }
}

const comboLine = (i: ItemObject): string => comboItemLine({
  text: toStr(i.field('Text')), key: i.key, image: toStr(i.field('Image')), selImage: toStr(i.field('SelImage')), indent: Math.max(0, Number(i.field('Indentation')) || 0),
});

export class ImageComboControl implements RichControl {
  private items: CollectionObject<ItemObject>;

  constructor(private h: RichHost) {
    const sel = { is: (i: ComboItem) => this.selected() === i, pick: (i: ComboItem) => this.select(i.index) };
    this.items = new CollectionObject<ItemObject>('ComboItems', args => {
      const indent = optPosition(args[5]) ?? 0;
      if (indent < 0) throw new VBRuntimeError(380);
      return { item: new ComboItem({ Key: optString(args[1]), Text: optString(args[2]), Image: optString(args[3]), SelImage: optString(args[4]), Indentation: indent }, sel), at: optPosition(args[0]) };
    }, (kind, item, at) => this.changed(kind, at));
    for (const line of this.lines()) {
      const d = parseComboItem(line);
      this.items.append(new ComboItem({ Text: d.text, Key: d.key, Image: d.image, SelImage: d.selImage, Indentation: d.indent }, sel));
    }
    this.syncSelection(false);
  }

  private get p(): Record<string, PropValue> { return this.h.props; }
  private lines(): string[] { return Array.isArray(this.p.ComboItems) ? this.p.ComboItems.map(String) : []; }
  private selected(): ItemObject | undefined { const n = Number(this.p.SelectedIndex) || 0; return n > 0 ? this.items.items()[n - 1] : undefined; }

  /** SelectedIndex follows the Text: the first item with that text (0 when there is none). */
  private syncSelection(send: boolean): void {
    const at = this.items.items().findIndex(i => toStr(i.field('Text')) === String(this.p.Text ?? '')) + 1;
    this.p.SelectedIndex = at;
    if (send) this.h.send({ SelectedIndex: at });
  }

  private changed(kind: ChangeKind, at: number): void {
    let sel = Number(this.p.SelectedIndex) || 0;
    if (kind === 'clear') sel = 0;
    else if (kind === 'add') { if (sel > 0 && at <= sel) sel++; }
    else if (kind === 'remove') { if (at === sel) sel = 0; else if (at < sel) sel--; }
    const lines = this.items.items().map(comboLine);
    this.p.ComboItems = lines;
    this.p.SelectedIndex = sel;
    this.h.send({ ComboItems: lines, SelectedIndex: sel });
  }

  /** Selects item `index` (1-based) by code: the Text shows it; no event, as for the window's own selection by Click. */
  private select(index: number): void {
    const it = this.items.items()[index - 1];
    if (!it) return;
    this.p.SelectedIndex = index;
    this.p.Text = toStr(it.field('Text'));
    this.h.send({ SelectedIndex: index, Text: this.p.Text });
  }

  get(name: string, args: VBValue[]): VBValue | undefined {
    if (name === 'ComboItems') return args.length ? this.items.getMember('Item', args) : this.items;
    if (name === 'SelectedItem') {
      if (args.length) throw new VBRuntimeError(450);
      return this.selected() ?? Nothing;
    }
    return undefined;
  }

  set(name: string, value: VBValue): boolean | Promise<void> {
    if (name === 'SelectedItem') {
      if (value === Nothing) throw new VBRuntimeError(91);
      const it = this.items.items().find(i => i === value);
      if (!it) throw new VBRuntimeError(5);
      this.select(it.index);
      return true;
    }
    if (name === 'Text') {
      const text = toStr(plainValue(value)), old = String(this.p.Text ?? '');
      this.p.Text = text;
      this.syncSelection(false);
      this.h.send({ Text: text, SelectedIndex: Number(this.p.SelectedIndex) });
      if (text !== old) void this.h.raise('Change', []);
      return true;
    }
    return false;
  }

  /** The user typed: the selection follows the text. */
  applyState(props: Record<string, PropValue>): void { if ('Text' in props && !('SelectedIndex' in props)) this.syncSelection(false); }

  dispose(): void { /* nothing is held */ }
}

// -- CoolBar -------------------------------------------------------------------------------------------------------

/** A Band: Caption (default), Key, Image, NewRow, Style, Child (a control of the form), MinWidth, Width (twips), Visible, Tag, Index. */
class BandItem extends ItemObject {
  child = '';
  constructor(init: Partial<BandData> & { Tag?: string }, private lookup: (name: string) => VBValue | undefined, private self: string) {
    super('Band', 'Caption', [
      { name: 'Caption', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Image', kind: 'string' }, { name: 'NewRow', kind: 'bool' },
      { name: 'Style', kind: 'long' }, { name: 'MinWidth', kind: 'long' }, { name: 'Width', kind: 'long' }, { name: 'Visible', kind: 'bool' }, { name: 'Tag', kind: 'any' },
    ], {
      Caption: init.caption ?? '', Key: init.key ?? '', Image: init.image ?? '', NewRow: init.newRow ?? false, Style: init.style ?? 0,
      MinWidth: init.minWidth ?? 0, Width: init.width ?? 0, Visible: init.visible ?? true,
    });
    this.child = init.child ?? '';
  }
  hasMember(name: string): boolean { return lc(name) === 'child' || super.hasMember(name); }
  getMember(name: string, args: VBValue[]): VBValue {
    if (lc(name) !== 'child') return super.getMember(name, args);
    if (args.length) throw new VBRuntimeError(450);
    return this.child === '' ? Nothing : this.lookup(this.child) ?? Nothing;
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (lc(name) !== 'child') {
      if ((lc(name) === 'width' || lc(name) === 'minwidth' || lc(name) === 'style') && Number(plainValue(value)) < 0) throw new VBRuntimeError(380);
      super.setMember(name, args, value);
      return;
    }
    if (args.length) throw new VBRuntimeError(450);
    if (value === Nothing) this.child = '';
    else {
      const c = asControl(value);
      if (!c || c.def.name.toLowerCase() === this.self.toLowerCase() || c.def.type === 'CoolBar') throw new VBRuntimeError(13);
      this.child = c.def.name;
    }
    this.owner?.itemChanged(this, 'Child');
  }
}

const bandData = (b: ItemObject): BandData => ({
  caption: toStr(b.field('Caption')), key: b.key, image: toStr(b.field('Image')), newRow: toBool(b.field('NewRow')), style: Number(b.field('Style')) || 0,
  child: (b as BandItem).child, minWidth: Number(b.field('MinWidth')) || 0, width: Number(b.field('Width')) || 0, visible: toBool(b.field('Visible')),
});

export class CoolBarControl implements RichControl {
  private bands: CollectionObject<ItemObject>;
  private lookup: (name: string) => VBValue | undefined;

  constructor(private h: RichHost) {
    this.lookup = n => { const c = h.controlByName?.(n); return asControl(c) ? c as unknown as VBValue : undefined; };
    this.bands = new CollectionObject<ItemObject>('Bands', args => {
      const style = optPosition(args[5]) ?? 0;
      if (style < 0) throw new VBRuntimeError(380);
      const item = new BandItem({ key: optString(args[1]), caption: optString(args[2]), image: optString(args[3]), newRow: args[4] !== undefined && toBool(plainValue(args[4])), style }, this.lookup, h.name);
      if (args[6] !== undefined && args[6] !== Nothing) item.setMember('Child', [], args[6]);
      return { item, at: optPosition(args[0]) };
    }, () => this.changed(true));
    const lines = Array.isArray(h.props.Bands) ? h.props.Bands.map(String) : [];
    for (const l of lines) this.bands.append(new BandItem(parseBand(l), this.lookup, h.name));
  }

  /** The height the rows of bands need, in twips (the heights of the children come from the form). */
  private needed(): number {
    const bs = this.bands.items().map(bandData);
    const content = bs.map(b => {
      const c = b.child ? asControl(this.h.controlByName?.(b.child)) : undefined;
      const hgt = c && typeof c.props.Height === 'number' ? twipsToPx(c.props.Height) : 0;
      return { image: 0, caption: 0, childWidth: 0, childHeight: hgt };
    });
    return coolbarHeight(bs, content) * 15;
  }

  /** The bands changed: the lines go to the window and the Height follows the rows; HeightChanged when it differs. */
  private changed(raise: boolean): void {
    const lines = this.bands.items().map(i => bandLine(bandData(i)));
    this.h.props.Bands = lines;
    this.h.send({ Bands: lines });
    this.fit(raise);
  }

  private fit(raise: boolean): void {
    if (!this.bands.count) return;
    const hgt = this.needed(), old = Number(this.h.props.Height) || 0;
    if (hgt === old) return;
    this.h.props.Height = hgt;
    this.h.send({ Height: hgt });
    if (raise) void this.h.raise('HeightChanged', [new VBRef(hgt)]);
  }

  get(name: string, args: VBValue[]): VBValue | undefined {
    return name === 'Bands' ? (args.length ? this.bands.getMember('Item', args) : this.bands) : undefined;
  }

  /** The window dragged bands: their widths. */
  applyState(props: Record<string, PropValue>): void {
    const lines = props.Bands;
    if (!Array.isArray(lines)) return;
    this.bands.items().forEach((b, i) => { if (lines[i] !== undefined) b.setRaw('Width', parseBand(String(lines[i])).width); });
  }

  /** Form_Load has finished: every control exists, the rows of bands give the Height. */
  async formLoaded(): Promise<void> { this.fit(false); }

  dispose(): void { /* nothing is held */ }
}
