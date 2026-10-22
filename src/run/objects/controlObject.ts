// Run-time control objects: a ControlObject mirrors one control's properties and queues every change
// as a patch to the form window; a ControlArrayObject is the `Command1(i)` collection.

import type { VBObject } from '../../lang/host';
import { VBRuntimeError } from '../../lang/errors';
import { Empty, Nothing, coerce, isObject, toBool, toStr, type VBValue } from '../../lang/values';
import { CONTROL_TYPES, getPropDef, type PropDef } from '../../model/controls';
import { decodeRuns, encodeRuns, formatAt, formatRange, replaceRange, runsText, type RtfPatch, type Run } from '../../controls/richText';
import { baseName, type FileDialogRequest } from '../commonDialog';
import type { ControlDef, FontValue, PictureRef, PropValue } from '../../model/types';
import type { PatchQueue } from '../patchQueue';
import { PictureObject, type HasPictureRef } from './appObjects';
import type { ChangeKind, CollectionObject, ItemObject } from './collectionObject';
import { makePanels, makeTabs, panelLine, tabLine } from './commonCollections';
import { DEFAULT_ALIGN, GridData } from './gridData';
import { columnLine, listLine, makeColumns, makeListItems, makeNodes, nodeLines, TreeNode, type NodesCollection, type Picker } from './listCollections';

export interface RunContext {
  resolveAsset(ref: PictureRef): string | null;
  loadPicture(path: string): Promise<VBValue>;
  /** A Timer's Enabled or Interval changed. */
  timerChanged(ctrl: ControlObject): void;
  /** A property was set by code (after the patch is queued); `old` is the value before. VB6 raises events for some (Text1.Text → Change). */
  propChanged?(ctrl: ControlObject, prop: string, old: PropValue): void;
  /** CommonDialog: the dialogs of the form host (file, colour, font). Null result = cancelled. */
  dialogs?: {
    fileDialog(o: FileDialogRequest): Promise<string | null>;
    colorDialog(o: { color: number }): Promise<number | null>;
    fontDialog(o: { font: FontValue }): Promise<FontValue | null>;
  };
}

/** Any picture value (what LoadPicture returns, or what `Picture` reads) carries its asset reference. */
export type { HasPictureRef };
const hasPictureRef = (v: unknown): v is HasPictureRef =>
  typeof v === 'object' && v !== null && 'pictureRef' in v;

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
  /** Item collections (lower-case property name): StatusBar.Panels, TabStrip.Tabs. */
  private readonly collections = new Map<string, CollectionObject<ItemObject>>();
  /** TreeView node / ListView item that is selected (by click or by code). */
  private selItem: ItemObject | null = null;
  /** MSFlexGrid cells. */
  private grid: GridData | null = null;
  /** RichTextBox: the text with its formats (the window gets it as the prop `Runs`) and the format waiting at the insertion point. */
  private runs: Run[] = [];
  private pendingFmt: RtfPatch | null = null;

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
    if (def.type === 'RichTextBox') {   // the selection starts out with the control's own font and colour
      const f = this.props.Font as FontValue;
      this.runs = decodeRuns(String(this.props.Runs ?? '')) ?? (this.props.Text ? [{ text: String(this.props.Text), fmt: {} }] : []);
      Object.assign(this.props, { SelBold: f.bold, SelItalic: f.italic, SelUnderline: f.underline,
        SelColor: this.props.ForeColor, SelFontName: f.name, SelFontSize: f.size });
    }
    if (def.type === 'StatusBar') {
      this.collections.set('panels', makePanels(this.lines('Panels'), (k, _i, at) => this.collectionChanged(k, at)));
    } else if (def.type === 'TabStrip') {
      const tabs = makeTabs(this.lines('Tabs'), (k, _i, at) => this.collectionChanged(k, at),
        { get: () => Number(this.props.SelectedTab), set: i => this.selectTab(i) });
      this.collections.set('tabs', tabs);
      const sel = Number(this.props.SelectedTab);
      this.props.SelectedTab = tabs.count === 0 ? 0 : Math.min(tabs.count, Math.max(1, sel || 1));
    } else if (def.type === 'TreeView') {
      this.collections.set('nodes', makeNodes(() => this.sendNodes(), this.picker()) as unknown as CollectionObject<ItemObject>);
    } else if (def.type === 'ListView') {
      this.collections.set('columnheaders', makeColumns(this.lines('ColumnHeaders'), () => this.sendColumns()));
      this.collections.set('listitems', makeListItems(() => this.sendItems(), this.picker()));
    } else if (def.type === 'MSFlexGrid') {
      this.grid = new GridData(Number(this.props.Rows), Number(this.props.Cols));
      this.props.Row = Math.min(Number(this.props.Row), this.grid.rows - 1);
      this.props.Col = Math.min(Number(this.props.Col), this.grid.cols - 1);
      this.syncGrid();
    }
  }

  // -- TreeView, ListView and MSFlexGrid: what the window gets ---------------------------------------------------

  private picker(): Picker { return { is: i => this.selItem === i, pick: i => this.select(i) }; }
  private selectedIndex(): number { return this.selItem?.owner ? this.selItem.index : 0; }
  private selProp(): string { return this.def.type === 'TreeView' ? 'SelectedNode' : 'SelectedIndex'; }

  /** Selects a node / list item by code (no NodeClick / ItemClick, as in VB6). */
  private select(i: ItemObject | null): void {
    this.selItem = i;
    this.props[this.selProp()] = this.selectedIndex();
    this.send({ [this.selProp()]: this.selectedIndex() });
  }

  private sendNodes(): void {
    const nodes = this.collections.get('nodes') as unknown as NodesCollection;
    const lines = nodeLines(nodes.roots);
    this.props.Nodes = lines;
    this.props.SelectedNode = this.selectedIndex();
    this.send({ Nodes: lines, SelectedNode: this.selectedIndex() });
  }
  private sendItems(): void {
    const lines = this.collections.get('listitems')!.items().map(listLine);
    this.props.ListItems = lines;
    this.props.SelectedIndex = this.selectedIndex();
    this.send({ ListItems: lines, SelectedIndex: this.selectedIndex() });
  }
  private sendColumns(): void {
    const lines = this.collections.get('columnheaders')!.items().map(columnLine);
    this.props.ColumnHeaders = lines;
    this.send({ ColumnHeaders: lines });
  }

  /** The grid arrays as window props (`cells` is shared, not copied; see gridData.ts). */
  private gridProps(all: boolean): Record<string, PropValue> {
    const g = this.grid!;
    const p: Record<string, PropValue> = { Cells: g.cells };
    if (all) Object.assign(p, { ColWidths: g.colWidth.map(String), RowHeights: g.rowHeight.map(String), ColAligns: g.colAlign.map(String) });
    return p;
  }
  private syncGrid(send = false): void {
    Object.assign(this.props, this.gridProps(true));
    if (send) this.send(this.gridProps(true));
  }
  /** Rows / Cols / FixedRows / FixedCols were set: resize the cells and keep Row / Col inside. */
  private gridResized(): void {
    const g = this.grid!;
    g.resize(Number(this.props.Rows), Number(this.props.Cols));
    this.props.Row = Math.min(Number(this.props.Row), g.rows - 1);
    this.props.Col = Math.min(Number(this.props.Col), g.cols - 1);
    this.syncGrid();
    this.send({ ...this.gridProps(true), Row: this.props.Row, Col: this.props.Col });
  }
  private gridIndex(args: VBValue[], n: number): number[] {
    if (args.length !== n) throw new VBRuntimeError(450);
    return args.map(a => num(this.plain(a)));
  }
  /** TextMatrix, Text, ColWidth, RowHeight, ColAlignment (get); undefined = an ordinary property. */
  private gridGet(l: string, args: VBValue[]): VBValue | undefined {
    const g = this.grid!;
    switch (l) {
      case 'textmatrix': { const [r, c] = this.gridIndex(args, 2); if (!g.has(r, c)) throw badIndex(); return g.get(r, c); }
      case 'text': if (args.length) throw new VBRuntimeError(450); return g.get(Number(this.props.Row), Number(this.props.Col));
      case 'colwidth': { const [c] = this.gridIndex(args, 1); if (!g.has(0, c)) throw badIndex(); return g.colWidth[c]; }
      case 'rowheight': { const [r] = this.gridIndex(args, 1); if (!g.has(r, 0)) throw badIndex(); return g.rowHeight[r]; }
      case 'colalignment': { const [c] = this.gridIndex(args, 1); if (!g.has(0, c)) throw badIndex(); return g.colAlign[c] ?? DEFAULT_ALIGN; }
    }
    return undefined;
  }
  private gridSet(l: string, args: VBValue[], value: VBValue): boolean {
    const g = this.grid!;
    switch (l) {
      case 'textmatrix': case 'text': {
        const [r, c] = l === 'text' ? [Number(this.props.Row), Number(this.props.Col)] : this.gridIndex(args, 2);
        if (l === 'text' && args.length) throw new VBRuntimeError(450);
        if (!g.has(r, c)) throw badIndex();
        g.set(r, c, toStr(this.plain(value)));
        this.send({ Cells: g.cells });
        return true;
      }
      case 'colwidth': case 'rowheight': case 'colalignment': {
        const [i] = this.gridIndex(args, 1), n = num(this.plain(value));
        if (l === 'rowheight' ? !g.has(i, 0) : !g.has(0, i)) throw badIndex();
        if (n < (l === 'colalignment' ? 0 : -1) || (l === 'colalignment' && n > 9)) throw new VBRuntimeError(380);
        if (l === 'colwidth') g.colWidth[i] = n; else if (l === 'rowheight') g.rowHeight[i] = n; else g.colAlign[i] = n;
        this.syncGrid(true);
        return true;
      }
    }
    return false;
  }

  private lines(prop: string): string[] { return Array.isArray(this.props[prop]) ? [...(this.props[prop] as string[])] : []; }

  /** A Panels/Tabs collection changed: keep the selected tab on the same tab, then send the lines to the window. */
  private collectionChanged(kind: ChangeKind, at: number): void {
    if (this.def.type === 'StatusBar') {
      const lines = this.collections.get('panels')!.items().map(panelLine);
      this.props.Panels = lines;
      this.send({ Panels: lines });
      return;
    }
    const tabs = this.collections.get('tabs')!;
    let sel = Number(this.props.SelectedTab);
    if (kind === 'clear') sel = 0;
    else if (kind === 'add') sel = tabs.count === 1 ? 1 : at <= sel ? sel + 1 : sel;
    else if (kind === 'remove') sel = at < sel ? sel - 1 : Math.min(sel, tabs.count);
    const lines = tabs.items().map(tabLine);
    this.props.Tabs = lines;
    this.props.SelectedTab = sel;
    this.send({ Tabs: lines, SelectedTab: sel });
  }

  /** TabStrip: select tab `i` by code (Tab.Selected = True, SelectedItem = …); raises Click like a click on the tab. */
  private selectTab(i: number): void {
    const old = this.props.SelectedTab;
    if (i === old) return;
    this.props.SelectedTab = i;
    this.send({ SelectedTab: i });
    this.ctx.propChanged?.(this, 'SelectedTab', old);
  }

  /** The arguments an event handler receives: object arguments (PanelClick's Panel) replace the index the window sent. */
  eventArgs(event: string, args: (number | string)[]): VBValue[] {
    const object = (collection: string): VBValue[] => [this.collections.get(collection)?.find(args[0]) ?? Nothing];
    switch (event) {
      case 'PanelClick': return object('panels');
      case 'NodeClick': case 'Expand': case 'Collapse': return object('nodes');
      case 'ItemClick': return object('listitems');
      case 'ColumnClick': return object('columnheaders');
    }
    return args;
  }

  get name(): string { return this.def.name; }
  get index(): number | null { return this.def.index; }

  /** State reported by the window (user input). Updates the mirror without sending a patch back. */
  applyState(props: Record<string, PropValue>): void {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'SelectedNode' || k === 'SelectedIndex') this.selItem = this.collections.get(k === 'SelectedNode' ? 'nodes' : 'listitems')?.find(Number(v)) ?? null;
      else if (k === 'Toggled') {   // 'index|0 or 1': a node was expanded / collapsed by a click on the +/- box
        const [i, on] = String(v).split('|');
        this.collections.get('nodes')?.find(Number(i))?.setRaw('Expanded', on === '1');
        const nodes = this.collections.get('nodes') as unknown as NodesCollection | undefined;
        if (nodes) this.props.Nodes = nodeLines(nodes.roots);
        continue;
      }
      this.props[getPropDef(this.def.type, k)?.name ?? k] = v;
    }
    if (this.def.type === 'RichTextBox') {   // the user typed, or moved the selection
      if ('Runs' in props) this.runs = decodeRuns(String(props.Runs ?? '')) ?? (this.props.Text ? [{ text: String(this.props.Text), fmt: {} }] : []);
      if ('SelStart' in props || 'SelLength' in props) this.pendingFmt = null;
    }
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
    const col = this.collections.get(l);
    if (col) return args.length ? col.getMember('Item', args) : col;
    if (pd.name === 'SelectedItem') {
      if (args.length) throw new VBRuntimeError(450);
      if (this.def.type === 'TabStrip') return this.collections.get('tabs')?.find(Number(this.props.SelectedTab)) ?? Nothing;
      return this.selItem?.owner ? this.selItem : Nothing;
    }
    if (this.grid) { const v = this.gridGet(l, args); if (v !== undefined) return v; }
    if (pd.kind === 'list') return this.getListItem(args);
    if (pd.name === 'Selected') return this.selected(args);
    if (args.length) throw new VBRuntimeError(450);
    const v = this.read(pd);
    if (pd.kind === 'font') return new FontObject(() => this.props.Font as FontValue, f => this.write(this.propDef('Font'), f));
    if (pd.kind === 'picture') return v ? new PictureObject(v as PictureRef) : Nothing;
    return v as VBValue;
  }

  setMember(name: string, args: VBValue[], value: VBValue): void {
    const pd = this.propDef(name);
    if (pd.runtime === 'ro' || name.toLowerCase() === 'name' || name.toLowerCase() === 'index') throw new VBRuntimeError(383);
    if (pd.name === 'SelectedItem') {
      if (args.length) throw new VBRuntimeError(450);
      if (value === Nothing) throw new VBRuntimeError(91);
      if (this.def.type !== 'TabStrip') {   // TreeView / ListView: a Node / ListItem of this control
        const item = this.collections.get(this.def.type === 'TreeView' ? 'nodes' : 'listitems')?.items().find(t => t === value);
        if (!item) throw new VBRuntimeError(5);
        this.select(item);
        return;
      }
      const tab = this.collections.get('tabs')?.items().find(t => t === value);
      if (!tab) throw new VBRuntimeError(5);
      this.selectTab(tab.index);
      return;
    }
    if (this.grid && this.gridSet(name.toLowerCase(), args, value)) return;
    if (this.grid && (pd.name === 'Row' || pd.name === 'Col')) {
      const n = num(this.plain(value));
      if (n < 0 || n >= (pd.name === 'Row' ? this.grid.rows : this.grid.cols)) throw new VBRuntimeError(380);
    }
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

  callMethod(name: string, args: VBValue[]): VBValue | Promise<VBValue> {
    const l = name.toLowerCase();
    if (!CONTROL_TYPES[this.def.type].methods.some(m => m.name.toLowerCase() === l)) throw new VBRuntimeError(438);
    switch (l) {
      case 'move': return this.move(args);
      case 'setfocus': this.queue.send(this.formKey, { t: 'focus', id: this.def.id }); return Empty;
      case 'additem': return this.addItem(args);
      case 'removeitem': return this.removeItem(args);
      case 'clear': return this.clear();
      case 'showopen': case 'showsave': return this.showFile(l === 'showopen');
      case 'showcolor': return this.showColor();
      case 'showfont': return this.showFont();
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
    const old = this.props[name === 'SelText' ? 'Text' : name];
    if (this.def.type === 'RichTextBox' && this.writeRich(pd, v, patch)) {
      // handled: the text with its formats is kept here, the window gets it as Runs
    } else if (name === 'SelText') {
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
    if (this.def.type === 'RichTextBox' && (name === 'SelStart' || name === 'SelLength' || name === 'SelText' || name === 'Text')) this.refreshSelFormat();
    this.send(patch);
    if (this.grid && (name === 'Rows' || name === 'Cols' || name === 'FixedRows' || name === 'FixedCols')) this.gridResized();
    if (this.def.type === 'Timer' && (name === 'Enabled' || name === 'Interval')) this.ctx.timerChanged(this);
    this.ctx.propChanged?.(this, name === 'SelText' ? 'Text' : name, old);
  }

  /** RichTextBox: SelBold ... describe the selection as it is now. */
  private refreshSelFormat(): void {
    const p = this.props, f = p.Font as FontValue;
    const fmt = { bold: f.bold, italic: f.italic, underline: f.underline, color: p.ForeColor, fontName: f.name, fontSize: f.size,
      ...formatAt(this.runs, Number(p.SelStart), Number(p.SelLength)), ...(Number(p.SelLength) === 0 ? this.pendingFmt : null) };
    Object.assign(p, { SelBold: fmt.bold, SelItalic: fmt.italic, SelUnderline: fmt.underline, SelColor: fmt.color, SelFontName: fmt.fontName, SelFontSize: fmt.fontSize });
  }

  /** RichTextBox: SelText, Text and the Sel<Format> properties work on the runs. False for every other property. */
  private writeRich(pd: PropDef, v: PropValue, patch: Record<string, PropValue>): boolean {
    const name = pd.name, p = this.props;
    const s = Math.min(Number(p.SelStart), runsText(this.runs).length), n = Number(p.SelLength);
    const FMT: Record<string, keyof RtfPatch> = { SelBold: 'bold', SelItalic: 'italic', SelUnderline: 'underline', SelColor: 'color', SelFontName: 'fontName', SelFontSize: 'fontSize' };
    if (name === 'SelText') {
      const ins = String(v);
      const fmt = this.pendingFmt ? { ...formatAt(this.runs, s, n), ...this.pendingFmt } : null;
      this.runs = replaceRange(this.runs, s, n, ins, fmt);
      this.pendingFmt = null;
      p.SelStart = s + ins.length; p.SelLength = 0;
      Object.assign(patch, { SelStart: p.SelStart, SelLength: 0 });
    } else if (name === 'Text') {
      this.runs = v === '' ? [] : [{ text: String(v), fmt: {} }];
      this.pendingFmt = null;
    } else if (FMT[name]) {
      p[name] = v;
      patch[name] = v;
      if (n > 0) this.runs = formatRange(this.runs, s, n, { [FMT[name]]: v } as RtfPatch);
      else this.pendingFmt = { ...this.pendingFmt, [FMT[name]]: v } as RtfPatch;
    } else {
      if (name === 'SelStart' || name === 'SelLength') this.pendingFmt = null;
      return false;
    }
    p.Text = runsText(this.runs);
    p.Runs = encodeRuns(this.runs);
    Object.assign(patch, { Text: p.Text, Runs: p.Runs });
    return true;
  }

  private send(props: Record<string, PropValue>): void {
    if (this.def.type === 'Timer' || this.def.type === 'CommonDialog') return;   // no view
    this.queue.set(this.formKey, this.def.id, props);
    // a RichTextBox applies each change at the selection as it is now: no merging of SelStart = 3 and SelBold = True into one patch
    if (this.def.type === 'RichTextBox') this.queue.flush();
  }

  // -- CommonDialog -----------------------------------------------------------------------------------------

  private dialogs(): NonNullable<RunContext['dialogs']> {
    if (!this.ctx.dialogs) throw new VBRuntimeError(438);
    return this.ctx.dialogs;
  }

  /** Cancel: error 32755 with CancelError = True, otherwise the call just returns and the properties stay. */
  private cancelled(): VBValue {
    if (this.props.CancelError === true) throw new VBRuntimeError(32755);
    return Empty;
  }

  private async showFile(open: boolean): Promise<VBValue> {
    const dialogs = this.dialogs();
    this.queue.flush();
    const p = this.props;
    const path = await dialogs.fileDialog({
      kind: open ? 'open' : 'save', filter: toStr(p.Filter as string), filterIndex: Number(p.FilterIndex),
      title: toStr(p.DialogTitle as string), initDir: toStr(p.InitDir as string), fileName: toStr(p.FileName as string),
    });
    if (path === null) return this.cancelled();
    p.FileName = path;
    p.FileTitle = baseName(path);
    return Empty;
  }

  private async showColor(): Promise<VBValue> {
    const dialogs = this.dialogs();
    this.queue.flush();
    const c = await dialogs.colorDialog({ color: Number(this.props.Color) });
    if (c === null) return this.cancelled();
    this.props.Color = c;
    return Empty;
  }

  private async showFont(): Promise<VBValue> {
    const dialogs = this.dialogs();
    this.queue.flush();
    const p = this.props;
    const f = await dialogs.fontDialog({ font: { name: toStr(p.FontName as string), size: Number(p.FontSize), bold: p.FontBold === true, italic: p.FontItalic === true, underline: p.FontUnderline === true } });
    if (f === null) return this.cancelled();
    Object.assign(p, { FontName: f.name, FontSize: f.size, FontBold: f.bold, FontItalic: f.italic, FontUnderline: f.underline });
    return Empty;
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
