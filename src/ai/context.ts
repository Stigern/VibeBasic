// Builds the text the AI sees: control type reference, form descriptions and chat messages.
import { CONTROL_TYPES, type PropDef } from '../model/controls';
import { listProcedures } from '../model/procedures';
import type { ControlDef, ControlType, FormDef, FontValue, ModuleDef, Project, PropValue } from '../model/types';
import type { ChatMessage } from './types';
import { BODY_OMITTED } from './omitted';
import { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from './prompts';

const COMMON = new Set(['left', 'top', 'width', 'height', 'visible', 'enabled', 'tabindex', 'tabstop', 'tag', 'tooltiptext']);
const BASE_METHODS = new Set(['move', 'setfocus', 'refresh', 'zorder']);

/** One line per control type, e.g. "CommandButton: Caption, Default, … | events: Click, … | methods: …". */
export function describeControlTypes(): string {
  const lines: string[] = [];
  for (const td of Object.values(CONTROL_TYPES)) {
    const props = td.props.filter(p => !COMMON.has(p.name.toLowerCase()) && (p.designTime || p.runtime !== 'none')).map(p => p.name);
    const methods = td.methods.filter(m => !BASE_METHODS.has(m.name.toLowerCase())).map(m => m.name);
    let line = `${td.type}: ${props.join(', ')} | events: ${td.events.map(e => e.name).join(', ')}`;
    if (methods.length) line += ` | methods: ${methods.join(', ')}`;
    lines.push(line);
  }
  lines.push('All controls also have: Left, Top, Width, Height, Visible, Enabled, TabIndex, Tag and the methods Move, SetFocus, Refresh, ZOrder.'
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
    + ' The dates of a DTPicker and a MonthView (Value, MinDate, MaxDate) are written as text like "2026-10-22" in the form description and in "props"; Format is dtpLongDate 0, dtpShortDate 1, dtpTime 2, dtpCustom 3 (CustomFormat "dd.MM.yyyy": d M y h H m s t tokens); MonthView StartOfWeek is 1 (Sunday) to 7.'
    + ' A MaskedEdit\'s Mask uses # digit, ? letter, A letter or digit, & any character, 9 / C / a optional, \\ escapes, other characters are literals; its Text is the whole display string ("__.__.____"), ClipText has the entries only.'
    + ' Inet and Winsock are invisible at run time (Left, Top, Tag only). Inet: s = Inet1.OpenURL(url) waits and returns the page; Inet1.Execute url, "GET" returns at once and raises StateChanged(State) with icResponseCompleted (then GetChunk(1024, icString) in a loop) or icError.'
    + ' Winsock: a client sets RemoteHost/RemotePort and calls Connect (Connect event, then SendData); a server sets LocalPort, calls Listen and in ConnectionRequest(requestID) calls Close and Accept requestID (or Load a new element of a Winsock control array and Accept there);'
    + ' in DataArrival(bytesTotal) Winsock1.GetData strData reads the text into a variable. Protocol sckUDPProtocol uses Bind and SendData with RemoteHost/RemotePort.'
    + ' A WebBrowser shows a page with Navigate "https://..." (NavigateComplete2, DocumentComplete, LocationURL, LocationName); many sites refuse to be shown inside another page.'
    + ' An MSChart draws a table of RowCount rows x ColumnCount columns (a column is a series, a row a data point; the sample data at first): chartType is VtChChartType2dBar 1, 3dBar 0, 2dLine 3, 2dArea 5, 2dStep 7, 2dPie 14, 2dXY 16 (3dLine 2, 3dArea 4, 3dStep 6); ShowLegend, TitleText, Stacking.'
    + ' Code fills it with MSChart1.ChartData = a 2-D array (strings in the first row and column are the labels) or with Row, Column, Data, RowLabel and ColumnLabel (counts from 1); MSChart1.Plot.Axis(VtChAxisIdX).AxisTitle.Text sets an axis title.'
    + ' An MMControl plays a file: FileName = App.Path & "\\x.wav", Command = "Open", then Command = "Play" (Mode mciModePlay 526, mciModeStop 525; Position and Length in ms;'
    + ' Notify = True before a command raises Done(NotifyCode) when it finishes). A MediaPlayer plays FileName (AutoStart) with Play, Pause, Stop; PlayStateChange(OldState, NewState), EndOfStream; CurrentPosition and Duration are seconds.'
    + ' An Agent is invisible: Agent1.Characters.Load "Robby" (or "Wizard"), then Set c = Agent1.Characters("Robby"): c.Show, c.Speak "Hi", c.Play "Wave" (Greet, Think, Explain, Congratulate, Surprised, Idle),'
    + ' c.MoveTo x, y and c.GestureAt x, y queue one after the other (pixels in the form); each returns a Request and raises Agent1_RequestComplete(Request).');
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
    out.push(`${pd.name}=${fmtValue(v)}`);
  }
  for (const [k, v] of Object.entries(props)) if (!defs.has(k) && !skip.has(k.toLowerCase())) out.push(`${k}=${fmtValue(v)}`);
  return out;
}

/** One line for the form, one per control in z-order. Only geometry and non-default properties are listed. */
export function describeForm(form: FormDef): string {
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
  return lines.join('\n');
}

/** "Form1: Command1 (CommandButton), Text1 (TextBox)" per form; control arrays are listed once. */
export function describeProjectForms(p: Project): string {
  return p.forms.map(f => {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const c of f.controls) {
      const k = c.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(`${c.name} (${c.type})`);
    }
    return `${f.name}: ${items.length ? items.join(', ') : '(no controls)'}`;
  }).join('\n');
}

function findItem(p: Project, id: string): { form?: FormDef; module?: ModuleDef } {
  const form = p.forms.find(f => f.id === id);
  if (form) return { form };
  return { module: p.modules.find(m => m.id === id) };
}

const LINE_BREAK = /\r\n|\n|\r/;
const mentions = (text: string, name: string): boolean => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'i').test(text);

/**
 * The code as the model should see it. Up to `maxLines` lines it is unchanged. Above that: everything outside
 * procedures (declarations), the whole current procedure, the whole procedures it calls or the request names
 * (case-insensitive), and only the heading line plus `' ... (body omitted)` for the rest.
 */
export function codeForPrompt(code: string, focus: { procName: string | null; mention: string }, maxLines = 400): string {
  const lines = code.split(LINE_BREAK);
  if (lines.length <= maxLines) return code;
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

export function buildCodeRequest(p: Project, itemId: string, cursorLine: number, userPrompt: string): ChatMessage[] {
  const { form, module } = findItem(p, itemId);
  const code = (form ?? module)?.code ?? '';
  const proc = listProcedures(code).find(pr => cursorLine >= pr.line && cursorLine <= pr.endLine);
  const context = form ? `Form description:\n${describeForm(form)}` : `Forms in the project:\n${describeProjectForms(p)}`;
  const user = `${context}\n\nCode of ${form ? `form ${form.name}` : `module ${module?.name ?? ''}`}:\n${codeForPrompt(code, { procName: proc?.name ?? null, mention: userPrompt })}\n\nCurrent procedure: ${proc?.name ?? '(none)'}\n\nRequest: ${userPrompt}`;
  return [{ role: 'system', content: `${CODE_SYSTEM_PROMPT}${describeControlTypes()}` }, { role: 'user', content: user }];
}

export interface FixError { number: number; description: string; compile: boolean; line: number; procName: string | null }

/**
 * Debugging with AI: the code-mode system prompt; in the user message the form description, the code (the procedure
 * with the error and its callers in full), the error, the line and the variable values, then `Fix the error.`
 */
export function buildFixRequest(p: Project, itemId: string, err: FixError, vars: { name: string; value: string }[]): ChatMessage[] {
  const { form, module } = findItem(p, itemId);
  const code = (form ?? module)?.code ?? '';
  const lines = code.split(LINE_BREAK);
  const procs = listProcedures(code);
  const proc = err.procName ? procs.find(pr => pr.name.toLowerCase() === err.procName!.toLowerCase()) : undefined;
  // the callers of the failing procedure: named in `mention`, so codeForPrompt keeps them whole
  const callers = proc ? procs.filter(pr => pr !== proc && mentions(lines.slice(pr.line, pr.endLine).join('\n'), proc.name)).map(pr => pr.name) : [];
  const context = form ? `Form description:\n${describeForm(form)}` : `Forms in the project:\n${describeProjectForms(p)}`;
  const what = err.compile ? `Compile error: ${err.description}` : `Run-time error ${err.number}: ${err.description}`;
  const lineText = (lines[err.line - 1] ?? '').trim();
  const parts = [
    context,
    `Code of ${form ? `form ${form.name}` : `module ${module?.name ?? ''}`}:\n${codeForPrompt(code, { procName: proc?.name ?? null, mention: callers.join(' ') })}`,
    `Error: ${what}`,
    `Line ${err.line} in ${proc?.name ?? '(declarations)'}: ${lineText}`,
  ];
  if (!err.compile) parts.push(`Variable values:\n${vars.length ? vars.map(v => `${v.name} = ${v.value}`).join('\n') : '(none)'}`);
  parts.push('Fix the error.');
  return [{ role: 'system', content: `${CODE_SYSTEM_PROMPT}${describeControlTypes()}` }, { role: 'user', content: parts.join('\n\n') }];
}

export function buildFormRequest(p: Project, formId: string, userPrompt: string): ChatMessage[] {
  const form = p.forms.find(f => f.id === formId);
  if (!form) throw new Error(`Unknown form ${formId}`);
  const user = `Form description:\n${describeForm(form)}\n\nForm code:\n${codeForPrompt(form.code, { procName: null, mention: userPrompt })}\n\nRequest: ${userPrompt}`;
  return [{ role: 'system', content: `${FORM_SYSTEM_PROMPT}${describeControlTypes()}` }, { role: 'user', content: user }];
}

export { stripThinking } from './clean';
export { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from './prompts';
