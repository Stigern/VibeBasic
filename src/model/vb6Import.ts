// Import of VB6 projects and files: .vbp (the project), .frm with its .frx (forms and their binary properties), .bas (standard
// modules) and .cls (class modules). VB6 files are Windows-1252 with CRLF line endings. Every problem that does not stop the
// import (an unsupported control, a missing file, code VibeBasic does not run ...) becomes a warning for the import report.
// The file reading is passed in (the backend's readBinaryFile in the IDE), so this stays pure and testable.
import { findSyntaxErrors } from '../lang/parser';
import { componentDef, normalizeComponents, usedComponents } from './components';
import { CONTROL_TYPES, getPropDef, newForm, newId, validateName } from './controls';
import { formClientTwips } from './geometry';
import { formHasProp, newMdiForm } from './mdi';
import { hasMenuBar } from './menus';
import { shortcutValue } from './menuShortcuts';
import { syncSSTab } from './ssTab';
import { DEFAULT_VERSION, type Asset, type ControlDef, type ControlType, type FontValue, type FormDef, type ModuleDef, type Project, type PropValue, type VersionInfo } from './types';
import { pictureAsset } from './vb6Image';

/** Reads a whole file; rejects when it is missing or unreadable. */
export type ReadBytes = (path: string) => Promise<Uint8Array>;

export interface Vb6ProjectImport { project: Project; warnings: string[] }
/** The items of one file added with Project > Add File. */
export interface Vb6FileImport { forms: FormDef[]; modules: ModuleDef[]; assets: Record<string, Asset>; components: string[]; warnings: string[] }

/** Windows-1252 text (a UTF-8 byte order mark switches to UTF-8). */
export function decode1252(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  return new TextDecoder('windows-1252').decode(b);
}

const splitLines = (text: string): string[] => text.split(/\r\n|\r|\n/);
const lc = (s: string): string => s.toLowerCase();
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const stem = (p: string): string => baseName(p).replace(/\.[^.]*$/, '');

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** `rel` (a VB6 path, backslashes, maybe ..\) against the folder `dir` (a POSIX path, no trailing slash). */
export function resolvePath(dir: string, rel: string): string {
  const r = rel.replace(/\\/g, '/');
  const parts = (r.startsWith('/') ? [] : dir.split('/')).concat(r.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') { if (out.length > 1) out.pop(); } else if (p !== '.' && (p !== '' || out.length === 0)) out.push(p);
  }
  return out.join('/') || '/';
}
const dirOf = (path: string): string => (path.includes('/') ? path.replace(/\/[^/]*$/, '') || '/' : '.');

// ---------------------------------------------------------------------------------------------------------------
// Control types and components

/** VB6 class names (lower case) → VibeBasic control types. ComctlLib / ComCtl2 are the VB5 common controls. */
const VB6_CLASSES: Record<string, ControlType> = Object.fromEntries(([
  ...['CommandButton', 'TextBox', 'Label', 'Frame', 'PictureBox', 'Image', 'ListBox', 'ComboBox', 'CheckBox', 'OptionButton',
    'HScrollBar', 'VScrollBar', 'Timer', 'Shape', 'Line', 'DriveListBox', 'DirListBox', 'FileListBox', 'Data', 'Menu'].map(t => [`VB.${t}`, t]),
  ...['TreeView', 'ListView', 'ProgressBar', 'StatusBar', 'Toolbar', 'ImageList', 'Slider', 'TabStrip', 'ImageCombo']
    .flatMap(t => [[`MSComctlLib.${t}`, t], [`ComctlLib.${t}`, t]]),
  ...['DTPicker', 'MonthView', 'UpDown', 'Animation', 'FlatScrollBar'].flatMap(t => [[`MSComCtl2.${t}`, t], [`ComCtl2.${t}`, t]]),
  ['ComCtl3.CoolBar', 'CoolBar'],
  ['MSFlexGridLib.MSFlexGrid', 'MSFlexGrid'], ['RichTextLib.RichTextBox', 'RichTextBox'], ['MSComDlg.CommonDialog', 'CommonDialog'],
  ['TabDlg.SSTab', 'SSTab'], ['MSWinsockLib.Winsock', 'Winsock'], ['InetCtlsObjects.Inet', 'Inet'], ['MSMask.MaskEdBox', 'MaskedEdit'],
  ['MSAdodcLib.Adodc', 'Adodc'], ['MSDataGridLib.DataGrid', 'DataGrid'], ['MSDataListLib.DataList', 'DataList'],
  ['MSDataListLib.DataCombo', 'DataCombo'], ['MSCommLib.MSComm', 'MSComm'], ['SysInfoLib.SysInfo', 'SysInfo'],
  ['MSChart20Lib.MSChart', 'MSChart'], ['MCI.MMControl', 'MMControl'], ['MediaPlayerCtl.MediaPlayer', 'MediaPlayer'],
  ['AgentObjectsCtl.Agent', 'Agent'], ['MSACAL.Calendar', 'Calendar'], ['SHDocVwCtl.WebBrowser', 'WebBrowser'],
  ...['SSPanel', 'SSCommand', 'SSCheck', 'SSOption', 'SSFrame', 'SSRibbon'].map(t => [`Threed.${t}`, t]),
] as [string, ControlType][]).map(([k, v]) => [lc(k), v]));

/** VB6 component files that VibeBasic knows by another file (the VB5 common controls). */
const COMPONENT_ALIASES: Record<string, string> = { 'comctl32.ocx': 'MSCOMCTL.OCX', 'comct232.ocx': 'MSCOMCT2.OCX' };

/** The component (canonical file name) of an `Object=` file, or null when VibeBasic has no such component. */
function mapComponent(file: string): string | null {
  const f = baseName(file.trim());
  return COMPONENT_ALIASES[lc(f)] ?? componentDef(f)?.file ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Property values

type RawValue = { kind: 'str'; s: string } | { kind: 'num'; n: number } | { kind: 'frx'; file: string; offset: number } | { kind: 'raw'; s: string };

/** One value of a .frm line: "text" ("" escapes), "Form1.frx":0000 (a .frx offset, also $"...":0000), &H8000000F&, -1 'True,
 *  8.25, or anything else as raw text (Shortcut = ^O); a trailing ' comment is dropped. */
export function parseValue(src: string): RawValue {
  let t = src.trim();
  if (t.startsWith('$"')) t = t.slice(1);
  if (t.startsWith('"')) {
    let s = '', i = 1;
    for (; i < t.length; i++) {
      if (t[i] === '"') { if (t[i + 1] === '"') { s += '"'; i++; } else break; } else s += t[i];
    }
    const m = /^:\s*([0-9A-Fa-f]+)/.exec(t.slice(i + 1));
    return m ? { kind: 'frx', file: s, offset: parseInt(m[1], 16) } : { kind: 'str', s };
  }
  const q = t.indexOf("'");
  if (q >= 0) t = t.slice(0, q).trim();
  const hex = /^&H([0-9A-Fa-f]+)&?$/i.exec(t);
  if (hex) return { kind: 'num', n: parseInt(hex[1], 16) | 0 };
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)(E[-+]?\d+)?$/i.test(t)) return { kind: 'num', n: Number(t) };
  if (/^true$/i.test(t)) return { kind: 'num', n: -1 };
  if (/^false$/i.test(t)) return { kind: 'num', n: 0 };
  return { kind: 'raw', s: t };
}

/** The Shortcut value of a .frm Shortcut (^O, {F1}, +^{F2}, ^{INSERT}, {DEL}, %{BKSP}); 0 when unknown. */
export function frmShortcut(s: string): number {
  const m = /^([\^+%]*)(\{(\w+)\}|.)$/.exec(s.trim());
  if (!m) return 0;
  const mods = m[1];
  const key = ({ insert: 'Ins', ins: 'Ins', delete: 'Del', del: 'Del', bksp: 'Bksp', backspace: 'Bksp', bs: 'Bksp' } as Record<string, string>)[lc(m[3] ?? '')]
    ?? (m[3] ?? m[2]).toUpperCase();
  const label = [mods.includes('+') ? 'Shift' : '', mods.includes('^') ? 'Ctrl' : '', mods.includes('%') ? 'Alt' : '', key].filter(Boolean).join('+');
  return shortcutValue(label) ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------
// .frx

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** A picture entry: a 4-byte length and the image (VB6 puts the "lt\0\0" header and a second length first for most). */
export function frxBlob(b: Uint8Array, off: number): Uint8Array {
  if (off + 4 > b.length) throw new Error('the .frx offset is past its end');
  const len = u32(b, off);
  if (b[off + 4] === 0x6c && b[off + 5] === 0x74 && b[off + 6] === 0 && b[off + 7] === 0) {
    const inner = u32(b, off + 8);
    return b.subarray(off + 12, Math.min(b.length, off + 12 + inner));
  }
  if (off + 4 + len > b.length) throw new Error('the .frx entry is cut short');
  return b.subarray(off + 4, off + 4 + len);
}

/** A string entry: a 4-byte length (Text of a multi-line TextBox ...) or a 1-byte one (0xFF: a 2-byte length follows). */
export function frxString(b: Uint8Array, off: number): string {
  const len4 = off + 4 <= b.length ? u32(b, off) : -1;
  if (len4 >= 0 && off + 4 + len4 <= b.length) return decode1252(b.subarray(off + 4, off + 4 + len4));
  if (b[off] === 0xff) return decode1252(b.subarray(off + 3, off + 3 + u16(b, off + 1)));
  return decode1252(b.subarray(off + 1, off + 1 + b[off]));
}

/** A string list (List of a ListBox / ComboBox): a 2-byte count, then a 2-byte length and the text of each item. */
export function frxList(b: Uint8Array, off: number): string[] {
  const n = u16(b, off);
  const out: string[] = [];
  let p = off + 2;
  for (let i = 0; i < n && p + 2 <= b.length; i++) {
    const len = u16(b, p);
    out.push(decode1252(b.subarray(p + 2, p + 2 + len)));
    p += 2 + len;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The .frm tree

interface FrmBlock { name: string; props: [string, RawValue][] }
interface FrmNode { cls: string; name: string; props: [string, RawValue][]; blocks: FrmBlock[]; children: FrmNode[] }

/** Parses `Begin Class Name ... End` from line `i`; returns the node and the line after its End. */
function parseNode(lines: string[], i: number): { node: FrmNode; next: number } {
  const head = /^\s*Begin\s+(\S+)\s+(\S+)/i.exec(lines[i])!;
  const node: FrmNode = { cls: head[1], name: head[2], props: [], blocks: [], children: [] };
  i++;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (/^End$/i.test(line)) return { node, next: i + 1 };
    if (/^Begin\s+\S+\s+\S+/i.test(line)) {
      const r = parseNode(lines, i);
      node.children.push(r.node);
      i = r.next;
      continue;
    }
    const bp = /^BeginProperty\s+(\S+)/i.exec(line);
    if (bp) {
      const block: FrmBlock = { name: bp[1], props: [] };
      let depth = 1;
      for (i++; i < lines.length && depth > 0; i++) {
        const l = lines[i].trim();
        if (/^BeginProperty\b/i.test(l)) depth++;
        else if (/^EndProperty\b/i.test(l)) depth--;
        else if (depth === 1) { const kv = /^([\w.()]+)\s*=(.*)$/.exec(l); if (kv) block.props.push([kv[1], parseValue(kv[2])]); }
      }
      node.blocks.push(block);
      continue;
    }
    const kv = /^([\w.()]+)\s*=(.*)$/.exec(line);
    if (kv) node.props.push([kv[1], parseValue(kv[2])]);
    i++;
  }
  return { node, next: i };
}

/** `Object = "{GUID}#2.0#0"; "MSCOMCTL.OCX"` (.frm) or `Object={GUID}#2.0#0; MSCOMCTL.OCX` (.vbp): the file name. */
const objectFile = (v: string): string => (v.split(';')[1] ?? '').trim().replace(/^"|"$/g, '');

const ATTRIBUTE_LINE = /^\s*Attribute\s+[\w.]+\s*=/i;

/** The code part: every Attribute line dropped, leading blank lines and trailing white space trimmed, '\n' line ends. */
function codeOf(lines: string[]): string {
  const kept = lines.filter(l => !ATTRIBUTE_LINE.test(l));
  while (kept.length && !kept[0].trim()) kept.shift();
  const code = kept.join('\n').replace(/\s+$/, '');
  return code ? code + '\n' : '';
}

/** The value of `Attribute VB_<name> = ...` in the header lines. */
function attribute(lines: string[], name: string): RawValue | null {
  const re = new RegExp(`^\\s*Attribute\\s+VB_${name}\\s*=(.*)$`, 'i');
  for (const l of lines) { const m = re.exec(l); if (m) return parseValue(m[1]); }
  return null;
}
const attrString = (lines: string[], name: string): string | null => { const v = attribute(lines, name); return v?.kind === 'str' ? v.s : null; };
const attrBool = (lines: string[], name: string): boolean | null => { const v = attribute(lines, name); return v?.kind === 'num' ? v.n !== 0 : null; };

// ---------------------------------------------------------------------------------------------------------------
// .frm

/** Twips per unit of a ScaleMode (1 twips, 2 points, 3 pixels, 5 inches, 6 millimetres, 7 centimetres); null for 0 (User) and
 *  4 (Characters), which are not converted. */
const SCALE_TWIPS: Record<number, number> = { 1: 1, 2: 20, 3: 15, 5: 1440, 6: 56.7, 7: 567 };
const SCALED = new Set(['left', 'top', 'width', 'height', 'x1', 'y1', 'x2', 'y2']);

interface FormContext {
  file: string;
  warn: (m: string) => void;
  frx: (file: string) => Uint8Array | null;
  assets: Record<string, Asset>;
  pending: Promise<void>[];
}

function readFrx(ctx: FormContext, v: Extract<RawValue, { kind: 'frx' }>): Uint8Array {
  const b = ctx.frx(v.file);
  if (!b) throw new Error(`${v.file} is missing`);
  return b;
}

const DEFAULT_FONT: FontValue = { name: 'MS Sans Serif', size: 8, bold: false, italic: false, underline: false };

function fontOf(block: FrmBlock): FontValue {
  const f = { ...DEFAULT_FONT };
  for (const [k, v] of block.props) {
    const key = lc(k);
    if (key === 'name' && v.kind === 'str') f.name = v.s;
    else if (key === 'size' && v.kind === 'num') f.size = v.n;
    else if (key === 'weight' && v.kind === 'num') f.bold = v.n >= 600;
    else if (key === 'bold' && v.kind === 'num') f.bold = v.n !== 0;
    else if (key === 'italic' && v.kind === 'num') f.italic = v.n !== 0;
    else if (key === 'underline' && v.kind === 'num') f.underline = v.n !== 0;
  }
  return f;
}

/** Sets the VB6 property `name` = `v` on `props` of a control of `type` when VibeBasic has it at design time (others are dropped
 *  quietly: LinkTopic, _ExtentX ...). Pictures are read from the .frx and converted later (ctx.pending). */
function applyProp(ctx: FormContext, owner: string, type: ControlType, props: Record<string, PropValue>, name: string, v: RawValue): void {
  const idx = /^(\w+)\((\d+)\)$/.exec(name);
  const pd = getPropDef(type, idx ? idx[1] : name);
  if (!pd || !pd.designTime) return;
  try {
    if (idx) {   // TabCaption(1) = "..." : one entry of a list property
      if (pd.kind !== 'list' || v.kind !== 'str') return;
      const list = Array.isArray(props[pd.name]) ? [...(props[pd.name] as string[])] : [];
      list[Number(idx[2])] = v.s;
      props[pd.name] = Array.from(list, s => s ?? '');
      return;
    }
    switch (pd.kind) {
      case 'int': case 'enum': case 'color': case 'date':
        if (v.kind === 'num') props[pd.name] = pd.kind === 'int' ? Math.round(v.n) : v.n;
        else if (pd.name === 'Shortcut' && v.kind === 'raw') props[pd.name] = frmShortcut(v.s);
        return;
      case 'bool':
        if (v.kind === 'num') props[pd.name] = v.n !== 0;
        return;
      case 'string': case 'text':
        if (v.kind === 'str') props[pd.name] = v.s;
        else if (v.kind === 'num') props[pd.name] = String(v.n);
        else if (v.kind === 'frx') props[pd.name] = frxString(readFrx(ctx, v), v.offset);
        return;
      case 'list':
        if (v.kind === 'frx') props[pd.name] = frxList(readFrx(ctx, v), v.offset);
        else if (v.kind === 'str') props[pd.name] = [v.s];
        return;
      case 'picture': {
        if (v.kind !== 'frx') return;
        const blob = frxBlob(readFrx(ctx, v), v.offset);
        if (!blob.length) return;
        const pdName = pd.name;
        ctx.pending.push(pictureAsset(blob).then(a => {
          const id = newId();
          ctx.assets[id] = { mime: a.mime, dataBase64: toBase64(a.bytes) };
          props[pdName] = { asset: id };
        }, e => ctx.warn(`${ctx.file}: ${owner}.${pdName}: the picture was left out (${(e as Error).message}).`)));
        return;
      }
      default:
    }
  } catch (e) {
    ctx.warn(`${ctx.file}: ${owner}.${pd.name}: ${(e as Error).message}; the property was left out.`);
  }
}

function applyBlocks(ctx: FormContext, owner: string, type: ControlType, props: Record<string, PropValue>, blocks: FrmBlock[]): void {
  for (const b of blocks) {
    const pd = getPropDef(type, b.name);
    if (pd?.kind === 'font' && pd.designTime) props[pd.name] = fontOf(b);
    else if (pd?.designTime) ctx.warn(`${ctx.file}: ${owner}.${pd.name} was not imported.`);
  }
}

function defaultProps(type: ControlType): Record<string, PropValue> {
  const props: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) props[pd.name] = structuredClone(pd.default);
  return props;
}

const propNum = (node: FrmNode, name: string): number | null => {
  const v = node.props.find(([k]) => lc(k) === lc(name))?.[1];
  return v?.kind === 'num' ? v.n : null;
};

/** The twips per unit of a container's ScaleMode (a warning and 1 for User / Characters). */
function scaleOf(ctx: FormContext, node: FrmNode, inherited: number): number {
  const mode = propNum(node, 'ScaleMode');
  if (mode === null) return node.cls.match(/^VB\.(Form|MDIForm|PictureBox)$/i) ? 1 : inherited;
  const f = SCALE_TWIPS[mode];
  if (f === undefined) ctx.warn(`${ctx.file}: ${node.name} has ScaleMode ${mode}; the positions of its controls were read as twips.`);
  return f ?? 1;
}

interface ParsedForm { form: FormDef; components: string[] }

/** Imports a .frm (its text, its .frx bytes by file name). Pictures are added to `assets` once `pending` has settled. */
function parseFrm(text: string, ctx: FormContext): ParsedForm {
  const lines = splitLines(text);
  const begin = lines.findIndex(l => /^\s*Begin\s+VB\.(Form|MDIForm)\s+\S+/i.test(l));
  if (begin < 0) throw new Error(`${ctx.file} is not a VB6 form file`);
  const components: string[] = [];
  for (const l of lines.slice(0, begin)) {
    const m = /^\s*Object\s*=(.*)$/i.exec(l);
    if (!m) continue;
    const file = objectFile(m[1]), comp = mapComponent(file);
    if (comp) components.push(comp);
    else if (file) ctx.warn(`${ctx.file}: the component ${file} is not supported.`);
  }
  const { node: root, next } = parseNode(lines, begin);
  const mdi = /^VB\.MDIForm$/i.test(root.cls);
  const nameAttr = attrString(lines.slice(next), 'Name') ?? root.name;
  const form = mdi ? newMdiForm(nameAttr) : newForm(nameAttr);
  form.code = codeOf(lines.slice(next));

  // the form's own properties (ClientWidth/Height become the outer Width/Height below)
  for (const [k, v] of root.props) {
    if (/^Client(Left|Top|Width|Height)$/i.test(k) || lc(k) === 'name' || !formHasProp(form, k)) continue;
    applyProp(ctx, form.name, 'Form', form.props, k, v);
  }
  applyBlocks(ctx, form.name, 'Form', form.props, root.blocks);
  if (mdi) for (const k of Object.keys(form.props)) if (!formHasProp(form, k)) delete form.props[k];

  // controls: VB6 writes siblings top-most first; `controls` is back first, so each sibling list is reversed. Menus keep their order.
  const controls: ControlDef[] = [], menus: ControlDef[] = [];
  const tabOf = new Map<string, number>();   // SSTab children: "name" / "name(index)" → tab
  const addNodes = (nodes: FrmNode[], parent: ControlDef | null, scale: number, parentIsMenu: boolean): void => {
    const ordered = parentIsMenu ? nodes : [...nodes.filter(n => !/^VB\.Menu$/i.test(n.cls)).reverse(), ...nodes.filter(n => /^VB\.Menu$/i.test(n.cls))];
    for (const n of ordered) {
      const type = VB6_CLASSES[lc(n.cls)] as Exclude<ControlType, 'Form'> | undefined;
      const isMenu = type === 'Menu';
      if (!type || (isMenu !== parentIsMenu && !(isMenu && parent === null))) {
        const inside = n.children.length ? ` and the ${n.children.length} control(s) on it were` : ' was';
        ctx.warn(`${ctx.file}: ${n.name} (${n.cls}) is not supported; it${inside} left out.`);
        continue;
      }
      const index = propNum(n, 'Index');
      const owner = index === null ? n.name : `${n.name}(${index})`;
      const props = defaultProps(type);
      for (const [k, v] of n.props) {
        if (lc(k) === 'index' || lc(k) === 'name') continue;
        if (SCALED.has(lc(k)) && v.kind === 'num') applyProp(ctx, owner, type, props, k, { kind: 'num', n: v.n * scale });
        else applyProp(ctx, owner, type, props, k, v);
      }
      applyBlocks(ctx, owner, type, props, n.blocks);
      const def: ControlDef = { id: newId(), type, name: n.name, index: index === null ? null : Math.round(index), parentId: parent?.id ?? null, props };
      if (type === 'SSTab') {
        for (const [k, v] of n.props) {
          const m = /^Tab\((\d+)\)\.Control\(\d+\)$/i.exec(k);
          if (m && v.kind === 'str') tabOf.set(lc(v.s), Number(m[1]));
        }
        syncSSTab(props, 'Tabs');
      }
      if (parent?.type === 'SSTab') {
        const t = tabOf.get(lc(owner)) ?? tabOf.get(lc(n.name));
        if (t) def.tab = t;
        if (typeof props.Left === 'number' && props.Left < -60000) props.Left += 75000;   // VB6 moves the other tabs' controls away
      }
      (isMenu ? menus : controls).push(def);
      addNodes(n.children, def, isMenu ? scale : scaleOf(ctx, n, scale), isMenu);
    }
  };
  addNodes(root.children, null, scaleOf(ctx, root, 1), false);
  form.controls = [...controls, ...menus];
  uniqueControls(form.controls, ctx);

  // outer size and position from the client area (VB6 stores the client area; VibeBasic's Width/Height are the window's)
  const BIG = 150000;
  const client = formClientTwips({ ...form.props, Width: BIG, Height: BIG }, hasMenuBar(form.controls));
  const cw = propNum(root, 'ClientWidth'), ch = propNum(root, 'ClientHeight');
  const cl = propNum(root, 'ClientLeft'), ct = propNum(root, 'ClientTop');
  if (cw !== null) form.props.Width = Math.round(cw) + (BIG - client.width);
  if (ch !== null) form.props.Height = Math.round(ch) + (BIG - client.height);
  const border = (BIG - client.width) / 2;
  if (cl !== null) form.props.Left = Math.max(0, Math.round(cl - border));
  if (ct !== null) form.props.Top = Math.max(0, Math.round(ct - (BIG - client.height - border)));
  return { form, components };
}

/**
 * Controls that share a name without being one control array (VB6 refuses to load such a form): those of the first one's
 * type become its control array (the next free indexes), any other type gets a free name. Each case is a warning.
 */
function uniqueControls(controls: ControlDef[], ctx: FormContext): void {
  const groups = new Map<string, ControlDef[]>();
  for (const c of controls) groups.set(lc(c.name), [...groups.get(lc(c.name)) ?? [], c]);
  const names = new Set(groups.keys());
  for (const group of groups.values()) {
    const first = group[0];
    if (group.every((c, i) => c.type === first.type && (group.length === 1 || (c.index !== null && group.findIndex(o => o.index === c.index) === i)))) continue;
    const used = new Set<number>();
    const free = (): number => { let i = 0; while (used.has(i)) i++; return i; };
    let arrayed = false;
    for (const c of group) {
      if (c.type !== first.type) {
        const name = freeName(first.name, names);
        names.add(lc(name));
        ctx.warn(`${ctx.file}: ${c.name} is also the name of a ${first.type}; this ${c.type} was renamed ${name}.`);
        c.name = name;
      } else if (c.index === null || used.has(c.index)) {
        c.index = free();
        arrayed = true;
      }
      if (c.type === first.type) used.add(c.index!);
    }
    if (arrayed) ctx.warn(`${ctx.file}: more than one control is named ${first.name}; they became the control array ${first.name}.`);
  }
}

/** `name` with the first free `_2`, `_3` ... suffix (at most 40 characters); `taken` is lower case. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `_${n}`, v = name.slice(0, 40 - suffix.length) + suffix;
    if (!taken.has(lc(v))) return v;
  }
}

/**
 * The project's name rules for imported forms, modules and classes: an invalid name becomes the next free Form<n> /
 * MDIForm<n> / Module<n> / Class<n>, a name already taken gets a `_2` suffix (each with a warning). `taken`: the names in
 * the project already (lower case); the new names are added to it.
 */
export function applyNameRules(items: readonly (FormDef | ModuleDef)[], taken: Set<string>, warn: (m: string) => void): void {
  for (const it of items) {
    const isForm = 'controls' in it;
    const base = isForm ? (it.mdi ? 'MDIForm' : 'Form') : it.kind === 'class' ? 'Class' : 'Module';
    const what = isForm ? (it.mdi ? 'MDI form' : 'form') : it.kind === 'class' ? 'class module' : 'module';
    let name = it.name;
    if (!validateName(name)) {
      let n = 1;
      while (taken.has(lc(`${base}${n}`))) n++;
      name = `${base}${n}`;
      warn(`"${it.name}" is not a valid name; the ${what} was renamed ${name}.`);
    } else if (taken.has(lc(name))) {
      name = freeName(name, taken);
      warn(`The name ${it.name} is already used; the ${what} was renamed ${name}.`);
    }
    it.name = name;
    taken.add(lc(name));
  }
}

/** Imports a .frm file: the form, its pictures as assets and the components its controls need. */
export async function importFrm(text: string, frx: (file: string) => Uint8Array | null, file: string, warn: (m: string) => void):
  Promise<{ form: FormDef; assets: Record<string, Asset>; components: string[] }> {
  const ctx: FormContext = { file, warn, frx, assets: {}, pending: [] };
  const { form, components } = parseFrm(text, ctx);
  await Promise.all(ctx.pending);
  return { form, assets: ctx.assets, components: normalizeComponents(components, usedComponents({ forms: [form] })) };
}

// ---------------------------------------------------------------------------------------------------------------
// .bas and .cls

/** A .bas: the module name from Attribute VB_Name (else the file name), then the code. */
export function importBas(text: string, file: string): ModuleDef {
  const lines = splitLines(text);
  return { id: newId(), name: attrString(lines, 'Name') ?? stem(file), code: codeOf(lines) };
}

/**
 * A .cls: a class module (kind 'class'). Instancing from the attributes as VB6 derives it: VB_Exposed False → 1 Private;
 * not creatable → 2 PublicNotCreatable; MultiUse = -1 → 5 MultiUse (6 GlobalMultiUse with VB_GlobalNameSpace); else 3 SingleUse
 * (4 GlobalSingleUse).
 */
export function importCls(text: string, file: string): ModuleDef {
  const lines = splitLines(text);
  let start = 0, multiUse = true;
  if (/^\s*VERSION\b/i.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, i) => i > 0 && /^\s*END\s*$/i.test(l));
    const header = lines.slice(1, end < 0 ? 1 : end);
    start = end < 0 ? 1 : end + 1;
    const mu = header.map(l => /^\s*MultiUse\s*=(.*)$/i.exec(l)).find(Boolean);
    if (mu) { const v = parseValue(mu[1]); multiUse = v.kind !== 'num' || v.n !== 0; }
  }
  const exposed = attrBool(lines, 'Exposed') ?? false;
  const creatable = attrBool(lines, 'Creatable') ?? true;
  const global = attrBool(lines, 'GlobalNameSpace') ?? false;
  const instancing = !exposed ? 1 : !creatable ? 2 : multiUse ? (global ? 6 : 5) : global ? 4 : 3;
  return { id: newId(), name: attrString(lines, 'Name') ?? stem(file), code: codeOf(lines.slice(start)), kind: 'class', instancing };
}

// ---------------------------------------------------------------------------------------------------------------
// Files and projects

/** The code problems of the imported items (Declare and the other VB6 statements VibeBasic does not run), at most 5 per item. */
function codeWarnings(items: { name: string; code: string }[], warn: (m: string) => void): void {
  for (const it of items) {
    const errs = findSyntaxErrors(it.code, it.name);
    for (const e of errs.slice(0, 5)) warn(`${it.name}, line ${e.line}: ${e.message}`);
    if (errs.length > 5) warn(`${it.name}: ${errs.length - 5} more line(s) with unsupported code.`);
  }
}

async function readFormFile(path: string, read: ReadBytes, warn: (m: string) => void): Promise<{ form: FormDef; assets: Record<string, Asset>; components: string[] }> {
  const text = decode1252(await read(path));
  const frxFiles = new Map<string, Uint8Array | null>();
  for (const m of text.matchAll(/"([^"\r\n]+\.frx)"\s*:/gi)) {
    const f = m[1];
    if (frxFiles.has(lc(f))) continue;
    const p = resolvePath(dirOf(path), f);
    frxFiles.set(lc(f), await read(p).catch(() => (warn(`${baseName(path)}: ${baseName(f)} is missing; its pictures and lists were left out.`), null)));
  }
  return importFrm(text, f => frxFiles.get(lc(f)) ?? null, baseName(path), warn);
}

/** Project > Add File: one .frm, .bas or .cls. `taken`: the project's names (an invalid or taken name is changed, with a
 *  warning). The caller checks for a second MDI form. */
export async function importVb6File(path: string, read: ReadBytes, taken: readonly string[] = []): Promise<Vb6FileImport> {
  const warnings: string[] = [];
  const warn = (m: string) => { warnings.push(m); };
  const ext = lc(path.split('.').pop() ?? '');
  const out: Vb6FileImport = { forms: [], modules: [], assets: {}, components: [], warnings };
  if (ext === 'frm') {
    const r = await readFormFile(path, read, warn);
    out.forms.push(r.form); out.assets = r.assets; out.components = r.components;
  } else if (ext === 'bas' || ext === 'cls') {
    const text = decode1252(await read(path));
    out.modules.push(ext === 'cls' ? importCls(text, path) : importBas(text, path));
  } else throw new Error(`${baseName(path)}: only .frm, .bas and .cls files can be added.`);
  applyNameRules([...out.forms, ...out.modules], new Set(taken.map(lc)), warn);
  codeWarnings([...out.forms, ...out.modules], warn);
  out.warnings = [...new Set(warnings)];
  return out;
}

export interface VbpInfo {
  name: string; title: string; startup: string; iconForm: string;
  forms: string[]; modules: string[]; classes: string[]; objects: string[];
  /** Other lines that name files VibeBasic cannot import (UserControl=, Designer= ...), as "Key=value". */
  unsupported: string[];
  /** Reference= lines that are not standard: their descriptions. */
  references: string[];
  /** MajorVer ... VersionCompanyName ... (Make tab of Project Properties); absent keys stay absent. */
  version: Partial<VersionInfo>;
  /** Command32 (Command Line Arguments) and CondComp (Conditional Compilation Arguments); '' when absent. */
  commandLine: string; condComp: string;
}

/** The Version* text keys of a .vbp and their VersionInfo fields. */
const VERSION_TEXT: Record<string, keyof VersionInfo> = {
  versioncomments: 'comments', versioncompanyname: 'companyName', versionfiledescription: 'fileDescription',
  versionlegalcopyright: 'legalCopyright', versionlegaltrademarks: 'legalTrademarks', versionproductname: 'productName',
};

/** Type libraries every VB6 project has or VibeBasic provides itself (OLE Automation, ADO, Scripting Runtime). */
const STANDARD_REFERENCES = /stdole2?\.tlb|msvbvm60|msado\d*\.(dll|tlb)|scrrun\.dll/i;

/** The lines of a .vbp up to its first [section]. */
export function parseVbp(text: string): VbpInfo {
  const info: VbpInfo = { name: '', title: '', startup: '', iconForm: '', forms: [], modules: [], classes: [], objects: [], unsupported: [], references: [],
    version: {}, commandLine: '', condComp: '' };
  const ver = (v: string): number => Math.max(0, Math.min(9999, Math.trunc(Number(unq(v))) || 0));
  const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');
  const fileOf = (v: string) => unq(v.includes(';') ? v.slice(v.indexOf(';') + 1) : v);
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = lc(line.slice(0, eq).trim()), v = line.slice(eq + 1);
    switch (key) {
      case 'form': info.forms.push(unq(v)); break;
      case 'module': info.modules.push(fileOf(v)); break;
      case 'class': info.classes.push(fileOf(v)); break;
      case 'object': info.objects.push(fileOf(v)); break;
      case 'name': info.name = unq(v); break;
      case 'title': info.title = unq(v); break;
      case 'startup': info.startup = unq(v); break;
      case 'iconform': info.iconForm = unq(v); break;
      case 'majorver': info.version.major = ver(v); break;
      case 'minorver': info.version.minor = ver(v); break;
      case 'revisionver': info.version.revision = ver(v); break;
      case 'autoincrementver': if (ver(v) !== 0) info.version.autoIncrement = true; break;   // off is absent, as the Make tab stores it
      case 'command32': info.commandLine = unq(v); break;
      case 'condcomp': info.condComp = unq(v); break;
      case 'reference': {
        const parts = v.split('#');
        if (!STANDARD_REFERENCES.test(v)) info.references.push(parts[parts.length - 1].trim() || v.trim());
        break;
      }
      case 'usercontrol': case 'designer': case 'propertypage': case 'userdocument': case 'resfile32':
        info.unsupported.push(`${line.slice(0, eq).trim()}=${unq(v)}`);
        break;
      default:
        if (VERSION_TEXT[key] && unq(v)) (info.version as Record<string, unknown>)[VERSION_TEXT[key]] = unq(v);
    }
  }
  return info;
}

/** File > Open Project with a .vbp: the whole project, read through `read`. Problems become warnings; the project has at least
 *  one form (a blank Form1 when the .vbp names none that could be read). */
export async function importVbp(path: string, read: ReadBytes): Promise<Vb6ProjectImport> {
  const warnings: string[] = [];
  const warn = (m: string) => { warnings.push(m); };
  const info = parseVbp(decode1252(await read(path)));
  const dir = dirOf(path);
  // a path in the .vbp that cannot be found is also tried next to it (projects moved from another machine)
  const readNear = async (rel: string): Promise<{ path: string; bytes: Uint8Array } | null> => {
    const first = resolvePath(dir, rel);
    for (const p of [first, resolvePath(dir, baseName(rel))]) {
      try { return { path: p, bytes: await read(p) }; } catch { /* next */ }
    }
    warn(`${rel} is missing; it was left out.`);
    return null;
  };
  const forms: FormDef[] = [], modules: ModuleDef[] = [];
  const assets: Record<string, Asset> = {};
  const components: string[] = [];
  for (const f of info.forms) {
    const r = await readNear(f);
    if (!r) continue;
    try {
      const imp = await readFormFile(r.path, async p => (p === r.path ? r.bytes : read(p)), warn);
      if (imp.form.mdi && forms.some(x => x.mdi)) {
        warn(`${baseName(f)}: a project can have only one MDI form; it was left out.`);
        continue;
      }
      forms.push(imp.form); Object.assign(assets, imp.assets); components.push(...imp.components);
    } catch (e) { warn(`${baseName(f)}: ${(e as Error).message}`); }
  }
  for (const [list, cls] of [[info.modules, false], [info.classes, true]] as const) {
    for (const f of list) {
      const r = await readNear(f);
      if (r) modules.push(cls ? importCls(decode1252(r.bytes), f) : importBas(decode1252(r.bytes), f));
    }
  }
  for (const o of info.objects) {
    const c = mapComponent(o);
    if (c) components.push(c); else warn(`The component ${baseName(o)} is not supported.`);
  }
  for (const u of info.unsupported) warn(`${u}: ${u.split('=')[0]} files are not supported; it was left out.`);
  for (const r of info.references) warn(`The reference "${r}" is not supported.`);
  const name = validateName(info.name) ? info.name : validateName(stem(path)) ? stem(path) : 'Project1';
  applyNameRules([...forms, ...modules], new Set([lc(name)]), warn);
  if (!forms.length) {
    let blank = 1;
    while (modules.some(m => lc(m.name) === `form${blank}`)) blank++;
    forms.push(newForm(`Form${blank}`));
    warn(`The project has no form that could be read; a blank Form${blank} was added.`);
  }
  // Startup="Sub Main": the Startup Object is Sub Main; startupForm stays a form (the one shown when Sub Main is switched off)
  const subMain = /^sub main$/i.test(info.startup);
  const startup = forms.find(f => lc(f.name) === lc(info.startup))?.name
    ?? (forms.find(f => !f.mdi && f.props.MDIChild !== true) ?? forms[0]).name;
  const iconForm = forms.find(f => lc(f.name) === lc(info.iconForm || startup));
  const icon = iconForm?.props.Icon;
  const project: Project = {
    name, title: info.title, startupForm: startup, forms, modules, assets,
    iconAsset: icon && typeof icon === 'object' && 'asset' in icon ? icon.asset : null,
    components: [],
    ...(subMain ? { subMain: true } : {}),
    ...(info.commandLine ? { commandLine: info.commandLine } : {}),
    ...(info.condComp ? { condComp: info.condComp } : {}),
    ...(Object.keys(info.version).length ? { versionInfo: { ...DEFAULT_VERSION, ...info.version } } : {}),
  };
  project.components = normalizeComponents(components, usedComponents(project));
  codeWarnings([...forms, ...modules], warn);
  return { project, warnings: [...new Set(warnings)] };
}
