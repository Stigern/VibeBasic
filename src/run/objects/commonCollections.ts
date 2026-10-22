// The collections of the Common Controls built on CollectionObject: StatusBar.Panels and TabStrip.Tabs.
// Design time stores them as lines ('Text|Key|Width|Alignment', 'Caption|Key'; see model/fieldLines.ts); at run time
// the lines seed the collection and every change is written back as lines for the window.

import { toBool, type VBValue } from '../../lang/values';
import { joinFields, splitFields } from '../../model/fieldLines';
import { CollectionObject, ItemObject, optPosition, optString, plainValue, type ChangeKind } from './collectionObject';

type Change = (kind: ChangeKind, item: ItemObject | null, at: number) => void;

/** A StatusBar Panel: Text (default), Width (twips, 0 = shares the rest), Alignment (sbrLeft/Center/Right), Key, Index, Tag. */
export function panelItem(init: { Text?: string; Key?: string; Width?: number; Alignment?: number } = {}): ItemObject {
  return new ItemObject('Panel', 'Text', [
    { name: 'Text', kind: 'string' }, { name: 'Width', kind: 'long' }, { name: 'Alignment', kind: 'long' },
    { name: 'Key', kind: 'string' }, { name: 'Tag', kind: 'any' },
  ], { ...init });
}

export function panelLine(p: ItemObject): string {
  return joinFields([String(p.field('Text')), String(p.field('Key')), Number(p.field('Width')) || '', Number(p.field('Alignment')) || '']);
}

export function makePanels(lines: string[], onChange: Change): CollectionObject<ItemObject> {
  // Add(Index, Key, Text, Style, Picture)
  const col = new CollectionObject<ItemObject>('Panels', args => ({
    item: panelItem({ Key: optString(args[1]), Text: optString(args[2]) }), at: optPosition(args[0]),
  }), onChange);
  for (const line of lines) {
    const [Text, Key, w, a] = splitFields(line);
    col.append(panelItem({ Text, Key, Width: Number(w) || 0, Alignment: Number(a) || 0 }));
  }
  return col;
}

/** A TabStrip Tab: Caption (default), Key, Image (index or key into the ImageList), Index, Tag, Selected (read/write; setting True selects the tab). */
class TabItem extends ItemObject {
  constructor(init: { Caption?: string; Key?: string; Image?: string }, private sel: { get(): number; set(i: number): void }) {
    super('Tab', 'Caption', [{ name: 'Caption', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Tag', kind: 'any' }, { name: 'Image', kind: 'string' }], { ...init });
  }
  hasMember(name: string): boolean { return name.toLowerCase() === 'selected' || super.hasMember(name); }
  getMember(name: string, args: VBValue[]): VBValue {
    return name.toLowerCase() === 'selected' ? this.sel.get() === this.index : super.getMember(name, args);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (name.toLowerCase() !== 'selected') { super.setMember(name, args, value); return; }
    if (toBool(plainValue(value))) this.sel.set(this.index);
  }
}

export function tabLine(t: ItemObject): string { return joinFields([String(t.field('Caption')), String(t.field('Key')), String(t.field('Image'))]); }

export function makeTabs(lines: string[], onChange: Change, sel: { get(): number; set(i: number): void }): CollectionObject<ItemObject> {
  // Add(Index, Key, Caption, Image)
  const col = new CollectionObject<ItemObject>('Tabs', args => ({
    item: new TabItem({ Key: optString(args[1]), Caption: optString(args[2]), Image: optString(args[3]) }, sel), at: optPosition(args[0]),
  }), onChange);
  for (const line of lines) { const [Caption, Key, Image] = splitFields(line); col.append(new TabItem({ Caption, Key, Image }, sel)); }
  return col;
}

