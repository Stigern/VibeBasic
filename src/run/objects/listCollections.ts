// The collections of TreeView (Nodes) and ListView (ListItems, ColumnHeaders) on top of CollectionObject.
// The window gets them as lines: nodes 'level|index|expanded|key|text' in tree order, list items 'index|text|sub1|sub2…',
// column headers 'Text|Key|Width|Alignment' (same as the design-time lines).

import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, coerce, isObject, toBool, toStr, type VBValue } from '../../lang/values';
import { joinFields, splitFields } from '../../model/fieldLines';
import { CollectionObject, ItemObject, optPosition, optString, plainValue, type AddResult, type ChangeKind } from './collectionObject';

type Change = (kind: ChangeKind, item: ItemObject | null, at: number) => void;
/** The selected node / list item of the owning control. */
export interface Picker { is(i: ItemObject): boolean; pick(i: ItemObject | null): void }
const lc = (s: string): string => s.toLowerCase();
const given = (v: VBValue | undefined): v is VBValue => v !== undefined && v !== Empty;

// ---------------------------------------------------------------------------------------------------------------
// TreeView

const TVW_FIRST = 0, TVW_LAST = 1, TVW_NEXT = 2, TVW_CHILD = 4;
const NODE_FIELDS = ['text', 'key', 'tag', 'expanded', 'index'];

/** A Node: Text (default), Key, Tag, Expanded, Index, Selected and the navigation members. */
export class TreeNode extends ItemObject {
  parent: TreeNode | null = null;
  kids: TreeNode[] = [];
  /** Where Add put it (consumed when the collection links the node into the tree). */
  pending: { rel: TreeNode | null; how: number } | null = null;

  constructor(init: { Text?: string; Key?: string }, private roots: TreeNode[], private sel: Picker) {
    super('Node', 'Text', [{ name: 'Text', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Tag', kind: 'any' }, { name: 'Expanded', kind: 'bool' }], { ...init });
  }

  siblings(): TreeNode[] { return this.parent ? this.parent.kids : this.roots; }
  private sibling(d: number): VBValue { const s = this.siblings(); return s[s.indexOf(this) + d] ?? Nothing; }

  hasMember(name: string): boolean {
    return ['parent', 'child', 'children', 'next', 'previous', 'firstsibling', 'lastsibling', 'root', 'selected'].includes(lc(name)) || super.hasMember(name);
  }

  getMember(name: string, args: VBValue[]): VBValue {
    const l = lc(name);
    if (NODE_FIELDS.includes(l) || !this.hasMember(name)) return super.getMember(name, args);
    if (args.length) throw new VBRuntimeError(450);
    const s = this.siblings();
    switch (l) {
      case 'parent': return this.parent ?? Nothing;
      case 'child': return this.kids[0] ?? Nothing;
      case 'children': return this.kids.length;
      case 'next': return this.sibling(1);
      case 'previous': return this.sibling(-1);
      case 'firstsibling': return s[0];
      case 'lastsibling': return s[s.length - 1];
      case 'root': { let n: TreeNode = this; while (n.parent) n = n.parent; return n; }
      default: return this.sel.is(this);   // selected
    }
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const l = lc(name);
    if (l === 'selected') {
      if (args.length) throw new VBRuntimeError(450);
      if (toBool(plainValue(value))) this.sel.pick(this); else if (this.sel.is(this)) this.sel.pick(null);
      return;
    }
    if (!NODE_FIELDS.includes(l) && this.hasMember(name)) throw new VBRuntimeError(383);
    super.setMember(name, args, value);
  }
}

/** Nodes: removing a node removes its children too. */
export class NodesCollection extends CollectionObject<TreeNode> {
  constructor(readonly roots: TreeNode[], factory: (args: VBValue[]) => AddResult<TreeNode>, onChange: (kind: ChangeKind, item: TreeNode | null, at: number) => void) {
    super('Nodes', factory, onChange);
  }
  remove(indexOrKey: VBValue): void {
    const n = this.get(indexOrKey);
    const gone: TreeNode[] = [];
    const walk = (x: TreeNode): void => { gone.push(x); x.kids.forEach(walk); };
    walk(n);
    const s = n.siblings();
    s.splice(s.indexOf(n), 1);
    n.parent = null;
    for (const d of gone.reverse()) super.remove(d.index);
  }
  clear(): void { this.roots.length = 0; super.clear(); }
}

/** Add(Relative, Relationship, Key, Text): no Relative = last root; a Relative without Relationship = tvwNext (VB6). */
export function makeNodes(onChange: Change, sel: Picker): NodesCollection {
  const roots: TreeNode[] = [];
  const col: NodesCollection = new NodesCollection(roots, args => {
    const node = new TreeNode({ Key: optString(args[2]), Text: optString(args[3]) }, roots, sel);
    if (given(args[0])) {
      const r = args[0];
      const rel = isObject(r) ? (r instanceof TreeNode && r.owner === (col as unknown) ? r : null) : col.find(r) ?? null;
      if (!rel) throw new VBRuntimeError(35600);
      const how = given(args[1]) ? (coerce(plainValue(args[1]), 'Long') as number) : TVW_NEXT;
      if (how < TVW_FIRST || how > TVW_CHILD) throw new VBRuntimeError(5);
      node.pending = { rel, how };
    }
    return { item: node };
  }, (kind, item, at) => {
    if (kind === 'add') {
      const n = item as TreeNode, { rel, how } = n.pending ?? { rel: null, how: TVW_LAST };
      n.pending = null;
      if (!rel) roots.push(n);
      else if (how === TVW_CHILD) { n.parent = rel; rel.kids.push(n); }
      else {
        const s = rel.siblings();
        n.parent = rel.parent;
        s.splice(how === TVW_FIRST ? 0 : how === TVW_LAST ? s.length : s.indexOf(rel) + (how === TVW_NEXT ? 1 : 0), 0, n);
      }
    }
    onChange(kind, item, at);
  });
  return col;
}

/** Tree order, depth first. */
export function nodeLines(roots: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[], level: number): void => {
    for (const n of ns) {
      out.push(joinFields([level, n.index, n.field('Expanded') ? 1 : 0, n.key, toStr(n.field('Text'))]));
      walk(n.kids, level + 1);
    }
  };
  walk(roots, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ListView

/** A ListItem: Text (default), Key, Tag, SubItems(i), Selected, Index. */
export class ListItem extends ItemObject {
  subs: string[] = [];
  constructor(init: { Text?: string; Key?: string }, private sel: Picker) {
    super('ListItem', 'Text', [{ name: 'Text', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Tag', kind: 'any' }], { ...init });
  }
  hasMember(name: string): boolean { return ['subitems', 'selected'].includes(lc(name)) || super.hasMember(name); }

  private subIndex(args: VBValue[]): number {
    if (args.length !== 1) throw new VBRuntimeError(450);
    const i = coerce(plainValue(args[0]), 'Long') as number;
    if (i < 0) throw new VBRuntimeError(35600);
    return i;
  }
  getMember(name: string, args: VBValue[]): VBValue {
    switch (lc(name)) {
      case 'subitems': { const i = this.subIndex(args); return i === 0 ? toStr(this.field('Text')) : this.subs[i - 1] ?? ''; }
      case 'selected': if (args.length) throw new VBRuntimeError(450); return this.sel.is(this);
    }
    return super.getMember(name, args);
  }
  setMember(name: string, args: VBValue[], value: VBValue): void {
    switch (lc(name)) {
      case 'subitems': {
        const i = this.subIndex(args), s = toStr(plainValue(value));
        if (i === 0) { super.setMember('Text', [], s); return; }
        while (this.subs.length < i) this.subs.push('');
        this.subs[i - 1] = s;
        this.owner?.itemChanged(this, 'SubItems');
        return;
      }
      case 'selected':
        if (args.length) throw new VBRuntimeError(450);
        if (toBool(plainValue(value))) this.sel.pick(this); else if (this.sel.is(this)) this.sel.pick(null);
        return;
    }
    super.setMember(name, args, value);
  }
}

export function makeListItems(onChange: Change, sel: Picker): CollectionObject<ItemObject> {
  // Add(Index, Key, Text, Icon, SmallIcon)
  return new CollectionObject<ItemObject>('ListItems', args => ({
    item: new ListItem({ Key: optString(args[1]), Text: optString(args[2]) }, sel), at: optPosition(args[0]),
  }), onChange);
}

export const listLine = (i: ItemObject): string => joinFields([i.index, toStr(i.field('Text')), ...(i as ListItem).subs]);

/** A ColumnHeader: Text (default), Key, Width (twips), Alignment (lvwColumnLeft/Right/Center), Tag, Index. */
function columnItem(init: { Text?: string; Key?: string; Width?: number; Alignment?: number }): ItemObject {
  return new ItemObject('ColumnHeader', 'Text', [
    { name: 'Text', kind: 'string' }, { name: 'Key', kind: 'string' }, { name: 'Width', kind: 'long' }, { name: 'Alignment', kind: 'long' }, { name: 'Tag', kind: 'any' },
  ], { ...init });
}
export const columnLine = (c: ItemObject): string =>
  joinFields([toStr(c.field('Text')), c.key, Number(c.field('Width')) || '', Number(c.field('Alignment')) || '']);

export function makeColumns(lines: string[], onChange: Change): CollectionObject<ItemObject> {
  // Add(Index, Key, Text, Width, Alignment, Icon)
  const col = new CollectionObject<ItemObject>('ColumnHeaders', args => ({
    item: columnItem({ Key: optString(args[1]), Text: optString(args[2]), Width: optPosition(args[3]) ?? 1440, Alignment: optPosition(args[4]) ?? 0 }),
    at: optPosition(args[0]),
  }), onChange);
  for (const line of lines) {
    const [Text, Key, w, a] = splitFields(line);
    col.append(columnItem({ Text, Key, Width: Number(w) || 0, Alignment: Number(a) || 0 }));
  }
  return col;
}
