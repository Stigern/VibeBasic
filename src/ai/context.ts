// Builds the text the AI sees: control type reference, form descriptions and chat messages.
import type { Expr, ModuleAst, Param, ProcDecl, VarDecl, VBTypeName } from '../lang/ast';
import { parseModuleLenient } from '../lang/parser';
import { CONTROL_TYPES, type PropDef } from '../model/controls';
import { absoluteRect, shownInDesign } from '../ide/designerLogic';
import { formClientTwips, isLine } from '../model/geometry';
import { hasMenuBar, isMenu, shortcutText } from '../model/menus';
import { listProcedures } from '../model/procedures';
import type { ControlDef, ControlType, FormDef, FontValue, ModuleDef, Project, PropValue } from '../model/types';
import type { TextMessage } from './types';
import { LANGUAGE_REFERENCE } from './langReference';
import { BODY_OMITTED } from './omitted';
import { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from './prompts';

const COMMON = new Set(['left', 'top', 'width', 'height', 'visible', 'enabled', 'tabindex', 'tabstop', 'tag', 'tooltiptext']);
const BASE_METHODS = new Set(['move', 'setfocus', 'refresh', 'zorder']);

/** The labels of an enum property: the registry's "0 - " numbering and "Justify" dropped, and a library prefix all of them share (ccOrientation, tvw, sld) cut off. */
function enumLabels(values: { value: number; label: string }[]): string[] {
  const labels = values.map(v => v.label.replace(/^-?\d+ - /, '').replace(/ Justify$/, ''));
  if (labels.length < 2 || labels.some(l => /\s/.test(l))) return labels;
  let n = 0;
  while (n < labels[0].length && labels.every(l => l[n] === labels[0][n])) n++;
  while (n > 0 && !labels.every(l => /[A-Z0-9]/.test(l[n] ?? ''))) n--;
  return n >= 2 && !/^\d/.test(labels[0].slice(n)) ? labels.map(l => l.slice(n)) : labels;
}

/** Enum properties of looks and layout written by name only, to keep the system prompt within its budget with the 0.8 controls:
 *  a wrong guess there only changes how a control looks. Alignment, ScrollBars, Style, MultiSelect, Value, the data and
 *  protocol enums ... keep their values (they change what a program does, and Alignment was misread without them). */
const NAME_ONLY_ENUMS = new Set(['align', 'appearance', 'arrows', 'autosize', 'backstyle', 'bevelinner', 'bevelouter', 'borderstyle', 'daylength',
  'fillstyle', 'floodtype', 'font3d', 'gridcelleffect', 'gridlines', 'linestyle', 'monthlength', 'negotiateposition', 'orientation', 'scrolling',
  'shadowstyle', 'shape', 'shortcut', 'startupposition', 'tickstyle', 'windowstate']);   // Shortcut: written as text ("Ctrl+O")

/** "Alignment(0 Left,1 Right,2 Center)": an enum property with its values; other properties by name. */
const propText = (p: PropDef): string =>
  p.enumValues?.length && !NAME_ONLY_ENUMS.has(p.name.toLowerCase())
    ? `${p.name}(${enumLabels(p.enumValues).map((l, i) => `${p.enumValues![i].value} ${l}`).join(',')})` : p.name;

/** The standard events, written as one word each in the control list (the note at the end spells them out). */
const EVENT_GROUPS: [string, string[]][] = [
  ['+focus', ['GotFocus', 'LostFocus']], ['+keys', ['KeyPress', 'KeyDown', 'KeyUp']], ['+mouse', ['MouseDown', 'MouseMove', 'MouseUp']],
];
function eventText(names: string[]): string[] {
  let out = [...names];
  for (const [word, group] of EVENT_GROUPS) {
    if (!group.every(g => out.includes(g))) continue;
    const at = out.indexOf(group[0]);
    out = out.flatMap((n, i) => (i === at ? [word] : group.includes(n) ? [] : [n]));
  }
  return out;
}

/** One line per control type, e.g. "CommandButton: Caption, Default, … | events: Click, … | methods: …". */
export function describeControlTypes(): string {
  const lines: string[] = [];
  for (const td of Object.values(CONTROL_TYPES)) {
    const props = td.props.filter(p => !COMMON.has(p.name.toLowerCase()) && (p.designTime || p.runtime !== 'none')).map(propText);
    const methods = td.methods.filter(m => !BASE_METHODS.has(m.name.toLowerCase())).map(m => m.name);
    let line = `${td.type}: ${props.join(', ')}`;
    if (td.events.length) line += ` | events: ${eventText(td.events.map(e => e.name)).join(', ')}`;
    if (methods.length) line += ` | methods: ${methods.join(', ')}`;
    lines.push(line);
  }
  lines.push('All controls also have: Left, Top, Width, Height, Visible, Enabled, TabIndex, Tag and the methods Move, SetFocus, Refresh, ZOrder.'
    + ' In the events, +focus is GotFocus and LostFocus, +keys KeyPress, KeyDown and KeyUp, +mouse MouseDown, MouseMove and MouseUp (VB6 parameters).'
    + ' Exceptions: Shape has no Enabled, TabIndex or SetFocus; Line has X1, Y1, X2, Y2 (twips) instead of Left, Top, Width, Height, and no Enabled, TabIndex, Move or SetFocus.'
    + ' A StatusBar always sits at the bottom of the form, full width (only its Height matters). Its Panels and a TabStrip\'s Tabs are one item per line,'
    + ' fields separated by | : Panels "Text|Key|Width|Alignment(0 left, 1 center, 2 right)", Tabs "Caption|Key".'
    + ' A ListView\'s ColumnHeaders are lines "Text|Key|Width|Alignment(0 left, 1 right, 2 center)"; Nodes, ListItems and the cells of an MSFlexGrid (TextMatrix) are filled by code at run time.'
    + ' A CommonDialog is invisible at run time and has only Left and Top (no Width, Height, Enabled, TabIndex) and no Move, SetFocus, Refresh or ZOrder; code opens it with ShowOpen, ShowSave, ShowColor or ShowFont (ShowPrinter and ShowHelp do not work).'
    + ' Its Filter looks like "Text (*.txt)|*.txt|All (*.*)|*.*".'
    + ' DriveListBox, DirListBox and FileListBox show the Mac\'s volumes, folders and files: Drive1.Drive is the path of a volume ("/" is the startup disk), Dir1.Path a folder, File1.Pattern "*.txt;*.bas".'
    + ' The usual link is Drive1_Change: Dir1.Path = Drive1.Drive, and Dir1_Change: File1.Path = Dir1.Path; File1.FileName is the selected file. The lists are filled asynchronously, so a read of ListCount or List(i) waits for the folder.'
    + ' An SSTab is a container with Tabs tabs (Tab is the current one, 0-based); TabCaption is one caption per line. A control added with "container" set to an SSTab goes on the tab given by "tab" (0-based, default the current tab); Top must leave room for the tabs (TabHeight, 520).'
    + ' A Toolbar sits at the top of the form, full width (Align = 1; only its Height matters); its Buttons are one per line "Caption|Key|Style|Image|ToolTipText"'
    + ' (Style 0 default, 1 check, 2 button group, 3 separator, 4 placeholder, 5 dropdown; Image is an index or key into its ImageList).'
    + ' An ImageList is invisible at run time; its pictures (ListImages) are added by the user in the Properties window or by code (ListImages.Add , "key", LoadPicture(path)),'
    + ' so leave ListImages alone. A Toolbar, TreeView, TabStrip (ImageList) and ListView (Icons, SmallIcons) name an ImageList control by its Name; a TabStrip tab\'s line is "Caption|Key|Image".'
    + ' The dates of a DTPicker and a MonthView (Value, MinDate, MaxDate) are written as text like "2026-10-22" in the form description and in "props"; a Custom Format uses CustomFormat "dd.MM.yyyy" (d M y h H m s t tokens).'
    + ' A MaskedEdit\'s Mask uses # digit, ? letter, A letter or digit, & any character, 9 / C / a optional, \\ escapes, other characters are literals; its Text is the whole display string ("__.__.____"), ClipText has the entries only.'
    + ' Inet and Winsock are invisible at run time (Left, Top, Tag only). Inet: s = Inet1.OpenURL(url) waits and returns the page; Inet1.Execute url, "GET" returns at once and raises StateChanged(State) with icResponseCompleted (then GetChunk(1024, icString) in a loop) or icError.'
    + ' Winsock: a client sets RemoteHost/RemotePort and calls Connect (Connect event, then SendData); a server sets LocalPort, calls Listen and in ConnectionRequest(requestID) calls Close and Accept requestID (or Load a new element of a Winsock control array and Accept there);'
    + ' in DataArrival(bytesTotal) Winsock1.GetData strData reads the text into a variable. Protocol sckUDPProtocol uses Bind and SendData with RemoteHost/RemotePort.'
    + ' MSComm and SysInfo are invisible at run time. MSComm: set CommPort (n = the n-th /dev/cu.* serial device) or PortName = "/dev/cu.usbmodem1101", Settings = "9600,n,8,1", RThreshold = 1, then PortOpen = True;'
    + ' MSComm1.Output = "text" sends; in MSComm1_OnComm check CommEvent = comEvReceive and read s = MSComm1.Input (InputLen 0 = all); PortOpen = False closes. SysInfo1.WorkAreaWidth ... are twips.'
    + ' An ImageCombo lists ComboItems "Text|Key|Image|SelImage|Indentation" (Image is an index or key into the ImageList named by its ImageList property); code: ImageCombo1.ComboItems.Add , "k", "Text", "imgkey".'
    + ' A CoolBar docks at the top (Align = 1) and its Bands are lines "Caption|Key|Image|NewRow(1)|Style|Child|MinWidth|Width"'
    + ' where Child is the Name of a control of the form (its Align must be 0) that the band hosts; its Height follows the rows of bands (HeightChanged(NewHeight)). A FlatScrollBar is like a scroll bar (Orientation 1 is horizontal).'
    + ' An Animation plays a GIF, APNG, WebP or MP4 (no AVI: error 35752): Animation1.Open App.Path & "\\spin.gif", Play [Repeat], [Start], [End] (Repeat -1 = for ever), Stop, Close; events Start, Stop; AutoPlay plays after Open.'
    + ' A Calendar (MSCAL) shows the month of its Value (a date); BeforeUpdate(Cancel).'
    + ' A WebBrowser shows a page with Navigate "https://..."; many sites refuse to be shown inside another page.'
    + ' An MSChart draws a table of RowCount rows x ColumnCount columns (a column is a series, a row a data point; the sample data at first).'
    + ' Code fills it with MSChart1.ChartData = a 2-D array (strings in the first row and column are the labels) or with Row, Column, Data, RowLabel and ColumnLabel (counts from 1); MSChart1.Plot.Axis(VtChAxisIdX).AxisTitle.Text sets an axis title.'
    + ' An MMControl plays a file: FileName = App.Path & "\\x.wav", Command = "Open", then Command = "Play" (Mode mciModePlay 526, mciModeStop 525; Position and Length in ms;'
    + ' Notify = True before a command raises Done(NotifyCode) when it finishes). A MediaPlayer plays FileName; PlayStateChange(OldState, NewState); CurrentPosition and Duration are seconds.'
    + ' An Agent is invisible: Agent1.Characters.Load "Robby" (or "Wizard"), then Set c = Agent1.Characters("Robby"): c.Show, c.Speak "Hi", c.Play "Wave" (Greet, Think, Explain, Congratulate, Surprised, Idle),'
    + ' c.MoveTo x, y and c.GestureAt x, y queue one after the other (pixels in the form); each returns a Request and raises Agent1_RequestComplete(Request).'
    + ' A Data control (DAO) or an Adodc (ADO) opens a SQLite database file (relative to App.Path, made when missing; no .mdb): Data1.DatabaseName = "people.db",'
    + ' Adodc1.ConnectionString = "Provider=SQLite;Data Source=people.db"; RecordSource is a table name or a SELECT. The recordset opens after Form_Load.'
    + ' TextBox, Label, CheckBox, ComboBox, ListBox, DTPicker and MaskedEdit bind with DataSource (the data control\'s Name) and DataField; their edits are saved when the record changes.'
    + ' Data1.Recordset: MoveFirst/MoveNext/MovePrevious/MoveLast, BOF, EOF, RecordCount, Fields("Name") or rs!Name, AddNew/Edit/Update (ADO: no Edit)/CancelUpdate/Delete, FindFirst "Name = \'x\'" (ADO: Find), Requery;'
    + ' events Data1_Validate(Action, Save) and Data1_Reposition, Adodc1_WillMove and Adodc1_MoveComplete. SQL from code: Data1.Database.Execute "CREATE TABLE IF NOT EXISTS ..."'
    + ' (Data1.Database.OpenRecordset("SELECT ...")) or Adodc1.Recordset.ActiveConnection.Execute sql; there is no New ADODB.Connection.'
    + ' A DataGrid shows the DataSource\'s records (Columns(0) is the first column: Caption, Width, Value).'
    + ' DataList and DataCombo list the ListField of the RowSource\'s records; BoundText is the BoundColumn of the chosen one, bound to DataSource / DataField.'
    + ' The Sheridan 3D controls: an SSPanel (or SSFrame) is a container like a Frame (BevelOuter 0 none, 1 inset, 2 raised, BevelWidth, Font3D 0-4; FloodType 1 left to right ... 5 circle with FloodPercent makes a progress bar);'
    + ' SSCheck and SSOption have a Boolean Value and Click(Value As Integer); SSRibbon is a toggle button (Value, PictureUp, PictureDn) and ribbons of one container with the same GroupNumber release each other.');
  return lines.join('\n');
}

const same = (a: PropValue, b: PropValue): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

function fmtFont(f: FontValue): string {
  return quote(`${f.name} ${f.size}pt${f.bold ? ' Bold' : ''}${f.italic ? ' Italic' : ''}${f.underline ? ' Underline' : ''}`);
}

function fmtValue(v: PropValue): string {
  if (v === null) return 'None';
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return quote(v.join('|'));
  if ('asset' in v) return '(picture)';
  return fmtFont(v);
}

const nameOf = (c: ControlDef): string => c.index === null ? c.name : `${c.name}(${c.index})`;

function propParts(type: ControlType, props: Record<string, PropValue>, skip: Set<string>): string[] {
  const defs = new Map<string, PropDef>(CONTROL_TYPES[type].props.map(p => [p.name, p]));
  const out: string[] = [];
  for (const pd of CONTROL_TYPES[type].props) {
    if (skip.has(pd.name.toLowerCase()) || !(pd.name in props)) continue;
    const v = props[pd.name];
    // An empty Text is still worth showing: it tells the model the box is blank on purpose.
    if (same(v, pd.default) && pd.name !== 'Text') continue;
    out.push(`${pd.name}=${type === 'Menu' && pd.name === 'Shortcut' ? quote(shortcutText(v)) : fmtValue(v)}`);   // Shortcut="Ctrl+O"
  }
  for (const [k, v] of Object.entries(props)) if (!defs.has(k) && !skip.has(k.toLowerCase())) out.push(`${k}=${fmtValue(v)}`);
  return out;
}

/** The size of the ASCII layout map in characters. */
export const MAP_COLS = 48, MAP_ROWS = 16;

/**
 * A coarse ASCII picture of the form's client area (for servers without vision): each control shown in the designer is a box
 * labelled with its name ("+Frame1---+" with "|" sides, or "[Text1--]" when it is one row high); "." is empty form.
 * Containers are drawn before their children, siblings in z-order. Controls invisible at run time and Lines are left out.
 */
export function layoutMap(form: FormDef, cols = MAP_COLS, rows = MAP_ROWS): string {
  const cl = formClientTwips(form.props, hasMenuBar(form.controls));
  const cw = Math.max(1, cl.width) / cols, ch = Math.max(1, cl.height) / rows;
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill('.'));
  const put = (y: number, x: number, ch_: string) => { if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = ch_; };
  const order: ControlDef[] = [];
  const visit = (parentId: string | null) => { for (const c of form.controls) if (c.parentId === parentId) { order.push(c); visit(c.id); } };
  visit(null);
  for (const c of order) {
    if (CONTROL_TYPES[c.type].invisibleAtRuntime || isLine(c) || isMenu(c) || !shownInDesign(form, c.id)) continue;
    const r = absoluteRect(form, c.id);
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
    const x1 = clamp(Math.floor(r.left / cw), cols), y1 = clamp(Math.floor(r.top / ch), rows);
    const x2 = Math.max(x1, clamp(Math.ceil((r.left + r.width) / cw) - 1, cols)), y2 = Math.max(y1, clamp(Math.ceil((r.top + r.height) / ch) - 1, rows));
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      const edgeY = y === y1 || y === y2, edgeX = x === x1 || x === x2;
      put(y, x, y1 === y2 ? (x === x1 ? '[' : x === x2 ? ']' : '-') : edgeX && edgeY ? '+' : edgeY ? '-' : edgeX ? '|' : ' ');
    }
    const name = nameOf(c);
    const room = x2 - x1 - 1;
    const text = room >= 1 ? name.slice(0, room) : name.slice(0, x2 - x1 + 1);
    for (let i = 0; i < text.length; i++) put(y1, (room >= 1 ? x1 + 1 : x1) + i, text[i]);
  }
  return grid.map(r => r.join('')).join('\n');
}

/**
 * One line for the form, one per control in z-order. Only geometry and non-default properties are listed.
 * With `map`, the ASCII layout map (layoutMap) follows.
 */
export function describeForm(form: FormDef, opts: { map?: boolean } = {}): string {
  const lines: string[] = [];
  const formParts = propParts('Form', form.props, new Set(['left', 'top', 'width', 'height', 'tabindex']));
  for (const k of ['Width', 'Height']) if (k in form.props) formParts.push(`${k}=${fmtValue(form.props[k])}`);
  lines.push(['Form', form.name, ...formParts].join(' '));
  const byId = new Map(form.controls.map(c => [c.id, c]));
  for (const c of form.controls) {
    const geo = ['Left', 'Top', 'Width', 'Height', 'X1', 'Y1', 'X2', 'Y2'].filter(k => k in c.props).map(k => `${k}=${fmtValue(c.props[k])}`);
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    const head = [c.type, nameOf(c)];
    if (parent) head.push('in', nameOf(parent));
    if (parent?.type === 'SSTab') head.push('tab', String(c.tab ?? 0));
    lines.push([...head, ...geo, ...propParts(c.type, c.props, new Set(['left', 'top', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'tabindex']))].join(' '));
  }
  if (opts.map) {
    const cl = formClientTwips(form.props, hasMenuBar(form.controls));
    lines.push(`Layout map of the client area (${cl.width} x ${cl.height} twips; one character is about ${Math.round(cl.width / MAP_COLS)} x ${Math.round(cl.height / MAP_ROWS)} twips):`, layoutMap(form));
  }
  return lines.join('\n');
}

/** "Form1: Command1 (CommandButton), Text1 (TextBox)"; control arrays are listed once. */
function describeFormControls(f: FormDef): string {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const c of f.controls) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(`${c.name} (${c.type})`);
  }
  return `${f.name}: ${items.length ? items.join(', ') : '(no controls)'}`;
}

/** "Form1: Command1 (CommandButton), Text1 (TextBox)" per form; control arrays are listed once. */
export function describeProjectForms(p: Project): string {
  return p.forms.map(describeFormControls).join('\n');
}

const literal = (e: Expr): string | null =>
  e.kind === 'number' ? String(e.value) : e.kind === 'string' ? quote(e.value) : e.kind === 'bool' ? (e.value ? 'True' : 'False')
    : e.kind === 'unary' && e.op === 'neg' && e.operand.kind === 'number' ? `-${e.operand.value}` : null;
const asType = (t: VBTypeName | undefined): string => t === undefined ? '' : ` As ${typeof t === 'string' ? t : 'userType' in t ? t.userType : t.objectType}`;
const param = (p: Param): string => `${p.paramArray ? 'ParamArray ' : p.optional ? 'Optional ' : ''}${p.byRef || p.paramArray ? '' : 'ByVal '}${p.name}${p.isArray ? '()' : ''}${asType(p.type)}`;
const signature = (p: ProcDecl): string =>
  `Public ${p.kind === 'sub' ? 'Sub' : 'Function'} ${p.name}(${p.params.map(param).join(', ')})${p.kind !== 'function' ? '' : p.returnsArray ? `${asType(p.returnType ?? 'Variant')}()` : asType(p.returnType)}`;
/** "Name As String * 20", "Items As New Collection", "a() As Long". */
const variable = (v: VarDecl): string =>
  `${v.name}${v.isArray ? '()' : ''}${v.isNew && v.type !== undefined ? asType(v.type).replace(' As ', ' As New ') : asType(v.type)}${v.fixedLength !== undefined ? ` * ${v.fixedLength}` : ''}`;

/** The Public items of a module or form, in source order: "Public Function Add(a As Integer) As Integer", "Public Enum Colors (Red, Green)". */
function publicItems(ast: ModuleAst): string[] {
  const items: { line: number; text: string }[] = [];
  const list = (names: string[]) => ` (${names.slice(0, 10).join(', ')}${names.length > 10 ? ', ...' : ''})`;
  for (const t of ast.types) if (t.visibility === 'public') items.push({ line: t.line, text: `Public Type ${t.name}${list(t.fields.map(f => f.name))}` });
  for (const e of ast.enums) if (e.visibility === 'public') items.push({ line: e.line, text: `Public Enum ${e.name}${list(e.members.map(m => m.name))}` });
  for (const c of ast.consts) {
    if (c.scope !== 'public') continue;
    const v = literal(c.value);
    items.push({ line: c.line, text: `Public Const ${c.name}${asType(c.type)}${v === null ? '' : ` = ${v}`}` });
  }
  for (const v of ast.variables) if (v.scope === 'public') items.push({ line: v.line, text: `Public ${variable(v)}` });
  for (const p of ast.procedures) if (p.visibility === 'public') items.push({ line: p.line, text: signature(p) });
  return items.sort((a, b) => a.line - b.line).map(i => i.text);
}

/** About how long the project symbols section may get. */
export const SYMBOLS_MAX_CHARS = 3000;

/**
 * One line per public item of the project's other modules and forms ("Module1: Public Function Add(a As Integer) As Integer"),
 * nearest first: the standard modules (their Public names are visible everywhere), then the other forms, each led by its
 * controls ("Form2: Text1 (TextBox), cmdOK (CommandButton)") unless `formControls` is false. `currentId` (its code is in the
 * message) is skipped. Capped at about `max` characters; the rest is counted in a last line.
 */
export function describeProjectSymbols(p: Project, currentId: string, formControls = true, max = SYMBOLS_MAX_CHARS): string {
  const lines: string[] = [];
  const itemsOf = (code: string, name: string) => { const ast = parseModuleLenient(code, name).ast; return ast ? publicItems(ast) : []; };
  for (const m of p.modules) if (m.id !== currentId) lines.push(...itemsOf(m.code, m.name).map(t => `${m.name}: ${t}`));
  for (const f of p.forms) {
    if (f.id === currentId) continue;
    if (formControls) lines.push(describeFormControls(f));
    lines.push(...itemsOf(f.code, f.name).map(t => `${f.name}: ${t}`));
  }
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > max) { out.push(`(${lines.length - out.length} more not shown)`); break; }
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

function findItem(p: Project, id: string): { form?: FormDef; module?: ModuleDef } {
  const form = p.forms.find(f => f.id === id);
  if (form) return { form };
  return { module: p.modules.find(m => m.id === id) };
}

const LINE_BREAK = /\r\n|\n|\r/;
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'i').test(text);

/** Without a known context size, code up to this many lines goes to the model unchanged. */
export const DEFAULT_MAX_LINES = 400;
/** The most code characters sent unchanged, whatever the context size. */
export const MAX_CODE_CHARS = 120000;

/** The code budget in characters for a context of `contextTokens` (half of it, at about 3.5 characters per token); undefined when unknown. */
export function codeBudget(contextTokens: number | undefined): number | undefined {
  return contextTokens && contextTokens > 0 ? Math.min(Math.floor(contextTokens * 3.5 * 0.5), MAX_CODE_CHARS) : undefined;
}

/**
 * The code as the model should see it. Up to `budgetChars` characters (unknown budget: up to 400 lines) it is unchanged.
 * Above that: everything outside procedures (declarations), the whole current procedure, the whole procedures it calls
 * or the request names (case-insensitive), and only the heading line plus `' ... (body omitted)` for the rest.
 */
export function codeForPrompt(code: string, focus: { procName: string | null; mention: string }, budgetChars?: number): string {
  const lines = code.split(LINE_BREAK);
  if (budgetChars === undefined ? lines.length <= DEFAULT_MAX_LINES : code.length <= budgetChars) return code;
  const procs = listProcedures(code);
  const current = focus.procName ? procs.find(p => p.name.toLowerCase() === focus.procName!.toLowerCase()) : undefined;
  const body = current ? lines.slice(current.line - 1, current.endLine).join('\n') : '';
  const keep = new Set<string>();
  if (current) keep.add(current.name.toLowerCase());
  for (const p of procs) if (mentions(focus.mention, p.name) || (current && mentions(body, p.name))) keep.add(p.name.toLowerCase());
  const out: string[] = [];
  let next = 1;
  for (const p of procs) {
    while (next < p.line) out.push(lines[next++ - 1]);
    if (keep.has(p.name.toLowerCase())) out.push(...lines.slice(p.line - 1, p.endLine));
    else out.push(lines[p.line - 1], BODY_OMITTED);
    next = p.endLine + 1;
  }
  while (next <= lines.length) out.push(lines[next++ - 1]);
  return out.join('\n');
}

/** What a request may know besides the project: the server's context size and (code mode) the selected text. */
export interface RequestOptions { contextTokens?: number; selection?: string | null }

let codeSystem: string | undefined, formSystem: string | undefined;
/** The system prompts, built once: byte-identical for every request (the server's prefix cache). */
const codeSystemPrompt = (): string => codeSystem ??= `${CODE_SYSTEM_PROMPT}${describeControlTypes()}\n${LANGUAGE_REFERENCE}`;
const formSystemPrompt = (): string => formSystem ??= `${FORM_SYSTEM_PROMPT}${describeControlTypes()}\n${LANGUAGE_REFERENCE}`;

/** The form description (or, for a module, the project's forms) followed by the project symbols, when there are any. */
function projectContext(p: Project, itemId: string, form: FormDef | undefined, map = false): string {
  const head = form ? `Form description:\n${describeForm(form, { map })}` : `Forms in the project:\n${describeProjectForms(p)}`;
  const symbols = describeProjectSymbols(p, itemId, !!form);
  return symbols ? `${head}\n\nProject symbols (other modules and forms):\n${symbols}` : head;
}

export function buildCodeRequest(p: Project, itemId: string, cursorLine: number, userPrompt: string, opts: RequestOptions = {}): TextMessage[] {
  const { form, module } = findItem(p, itemId);
  const code = (form ?? module)?.code ?? '';
  const proc = listProcedures(code).find(pr => cursorLine >= pr.line && cursorLine <= pr.endLine);
  const parts = [
    projectContext(p, itemId, form),
    `Code of ${form ? `form ${form.name}` : `module ${module?.name ?? ''}`}:\n${codeForPrompt(code, { procName: proc?.name ?? null, mention: userPrompt }, codeBudget(opts.contextTokens))}`,
  ];
  if (opts.selection?.trim()) {
    parts.push(`Selected code (the request is about this):\n${opts.selection}\n`
      + 'Answer with the whole procedure, or with only the new code for the selected lines (no Sub line).');
  }
  parts.push(`Current procedure: ${proc?.name ?? '(none)'}`, `Request: ${userPrompt}`);
  return [{ role: 'system', content: codeSystemPrompt() }, { role: 'user', content: parts.join('\n\n') }];
}

export interface FixError { number: number; description: string; compile: boolean; line: number; procName: string | null }

/**
 * Debugging with AI: the code-mode system prompt; in the user message the form description, the code (the procedure
 * with the error and its callers in full), the error, the line and the variable values, then `Fix the error.`
 */
export function buildFixRequest(p: Project, itemId: string, err: FixError, vars: { name: string; value: string }[], opts: RequestOptions = {}): TextMessage[] {
  const { form, module } = findItem(p, itemId);
  const code = (form ?? module)?.code ?? '';
  const lines = code.split(LINE_BREAK);
  const procs = listProcedures(code);
  const proc = err.procName ? procs.find(pr => pr.name.toLowerCase() === err.procName!.toLowerCase()) : undefined;
  // the callers of the failing procedure: named in `mention`, so codeForPrompt keeps them whole
  const callers = proc ? procs.filter(pr => pr !== proc && mentions(lines.slice(pr.line, pr.endLine).join('\n'), proc.name)).map(pr => pr.name) : [];
  const what = err.compile ? `Compile error: ${err.description}` : `Run-time error ${err.number}: ${err.description}`;
  const lineText = (lines[err.line - 1] ?? '').trim();
  const parts = [
    projectContext(p, itemId, form),
    `Code of ${form ? `form ${form.name}` : `module ${module?.name ?? ''}`}:\n${codeForPrompt(code, { procName: proc?.name ?? null, mention: callers.join(' ') }, codeBudget(opts.contextTokens))}`,
    `Error: ${what}`,
    `Line ${err.line} in ${proc?.name ?? '(declarations)'}: ${lineText}`,
  ];
  if (!err.compile) parts.push(`Variable values:\n${vars.length ? vars.map(v => `${v.name} = ${v.value}`).join('\n') : '(none)'}`);
  parts.push('Fix the error.');
  return [{ role: 'system', content: codeSystemPrompt() }, { role: 'user', content: parts.join('\n\n') }];
}

export function buildFormRequest(p: Project, formId: string, userPrompt: string, opts: RequestOptions = {}): TextMessage[] {
  const form = p.forms.find(f => f.id === formId);
  if (!form) throw new Error(`Unknown form ${formId}`);
  const user = `${projectContext(p, formId, form, true)}\n\nForm code:\n${codeForPrompt(form.code, { procName: null, mention: userPrompt }, codeBudget(opts.contextTokens))}\n\nRequest: ${userPrompt}`;
  return [{ role: 'system', content: formSystemPrompt() }, { role: 'user', content: user }];
}

export { stripThinking } from './clean';
export { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from './prompts';
