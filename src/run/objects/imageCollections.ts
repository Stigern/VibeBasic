// The collections of ImageList (ListImages) and Toolbar (Buttons) on top of CollectionObject.
// Design time stores them as lines (ListImages 'Key|asset|Tag', Buttons 'Caption|Key|Style|Image|ToolTipText'; see model/imageList.ts and
// model/toolbar.ts); at run time the lines seed the collection and every change is written back as lines for the window.

import { VBRuntimeError } from '../../lang/errors';
import { Empty, toBool, toStr, type VBValue } from '../../lang/values';
import { listImageLine, parseListImage } from '../../model/imageList';
import { TBR_DEFAULT, buttonLine, parseButton, type ToolbarButtonData } from '../../model/toolbar';
import type { PictureRef } from '../../model/types';
import { PictureObject, type HasPictureRef } from './appObjects';
import { CollectionObject, ItemObject, optPosition, optString, plainValue, type ChangeKind } from './collectionObject';

type Change = (kind: ChangeKind, item: ItemObject | null, at: number) => void;
const lc = (s: string): string => s.toLowerCase();
const hasRef = (v: unknown): v is HasPictureRef => typeof v === 'object' && v !== null && 'pictureRef' in v;

/** A ListImage: Key, Index, Tag and Picture (a Picture object; assigning one replaces the image). */
export class ListImageItem extends ItemObject {
  constructor(init: { Key?: string; Tag?: string }, public asset: string) {
    super('ListImage', 'Key', [{ name: 'Key', kind: 'string' }, { name: 'Tag', kind: 'string' }], { ...init });
  }
  hasMember(name: string): boolean { return lc(name) === 'picture' || super.hasMember(name); }
  getMember(name: string, args: VBValue[]): VBValue {
    if (lc(name) !== 'picture') return super.getMember(name, args);
    return new PictureObject(this.asset ? { asset: this.asset } : null);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    if (lc(name) !== 'picture') { super.setMember(name, args, value); return; }
    if (!hasRef(value) || !value.pictureRef) throw new VBRuntimeError(380);
    this.asset = value.pictureRef.asset;
    this.owner?.itemChanged(this, 'Picture');
  }
}

export const listImageItemLine = (i: ItemObject): string =>
  listImageLine({ key: i.key, asset: (i as ListImageItem).asset, tag: toStr(i.field('Tag')) });

export function makeListImages(lines: string[], onChange: Change): CollectionObject<ItemObject> {
  // Add(Index, Key, Picture)
  const col = new CollectionObject<ItemObject>('ListImages', args => {
    const pic = args[2] === undefined || args[2] === Empty ? undefined : plainValueOrSelf(args[2]);
    if (!pic) throw new VBRuntimeError(449);
    if (!hasRef(pic) || !pic.pictureRef) throw new VBRuntimeError(380);
    return { item: new ListImageItem({ Key: optString(args[1]) }, (pic.pictureRef as PictureRef).asset), at: optPosition(args[0]) };
  }, onChange);
  for (const line of lines) { const i = parseListImage(line); col.append(new ListImageItem({ Key: i.key, Tag: i.tag }, i.asset)); }
  return col;
}

/** A Picture object is passed as it is (it has no default member). */
function plainValueOrSelf(v: VBValue): VBValue { return hasRef(v) ? v : plainValue(v); }

// ---------------------------------------------------------------------------------------------------------------

/** A Toolbar Button: Caption, Key, Style, Image (index or key into the ImageList), Value (tbrUnpressed 0, tbrPressed 1), Enabled,
 *  Visible, ToolTipText, Tag, Description, Index. */
export function buttonItem(init: Partial<ToolbarButtonData> & { Tag?: string } = {}): ItemObject {
  return new ItemObject('Button', 'Caption', [
    { name: 'Caption', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Style', kind: 'long' }, { name: 'Image', kind: 'string' },
    { name: 'Value', kind: 'long' }, { name: 'Enabled', kind: 'bool' }, { name: 'Visible', kind: 'bool' },
    { name: 'ToolTipText', kind: 'string' }, { name: 'Tag', kind: 'any' }, { name: 'Description', kind: 'string' },
  ], {
    Caption: init.caption ?? '', Key: init.key ?? '', Style: init.style ?? TBR_DEFAULT, Image: init.image ?? '', Value: init.value ?? 0,
    Enabled: init.enabled ?? true, Visible: init.visible ?? true, ToolTipText: init.tip ?? '',
  });
}

export function buttonDataOf(b: ItemObject): ToolbarButtonData {
  return {
    caption: toStr(b.field('Caption')), key: b.key, style: Number(b.field('Style')) || 0, image: toStr(b.field('Image')),
    tip: toStr(b.field('ToolTipText')), value: Number(b.field('Value')) ? 1 : 0, enabled: toBool(b.field('Enabled')), visible: toBool(b.field('Visible')),
  };
}
export const toolbarLine = (b: ItemObject): string => buttonLine(buttonDataOf(b));

export function makeButtons(lines: string[], onChange: Change): CollectionObject<ItemObject> {
  // Add(Index, Key, Caption, Style, Image)
  const col = new CollectionObject<ItemObject>('Buttons', args => {
    const style = optPosition(args[3]) ?? TBR_DEFAULT;
    if (style < 0 || style > 5) throw new VBRuntimeError(380);
    return { item: buttonItem({ key: optString(args[1]), caption: optString(args[2]), style, image: optString(args[4]) }), at: optPosition(args[0]) };
  }, onChange);
  for (const line of lines) col.append(buttonItem(parseButton(line)));
  return col;
}
