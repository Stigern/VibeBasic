// The code window: one CodeMirror 6 editor per form/module (Full Module View) with Object/Procedure dropdowns.
// Leaving a line prettifies it (plan 01 prettifyLine + control property spelling) and, when Auto Syntax Check is on,
// marks it red and shows the compile error box. Edits write form.code / module.code and mark the project dirty.
import { Annotation, Compartment, EditorState, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, hoverTooltip, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, undo, redo, deleteCharForward } from '@codemirror/commands';
import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { tokenize } from '../lang/lexer';
import { checkLineSyntax } from '../lang/parser';
import { collectIdentifiers, prettifyLine } from '../lang/prettify';
import { CONTROL_TYPES, getPropDef, type EventDef } from '../model/controls';
import { formEvents, formObjectName } from '../model/mdi';
import { buildEventStub, findProcedureRange, insertProcedure, listProcedures, procLabel } from '../model/procedures';
import type { ControlType, FormDef, Project } from '../model/types';
import { compileErrorBox } from '../ui98/dialogs';
import { createCombo, type Combo } from '../ui98/combo';
import { h } from '../ui98/dom';
import { popupMenu, type PopupItem } from '../ui98/popup';
import { createMdiWindow, type MdiWindow } from '../ui98/mdiWindow';
import { openDesigner } from './designer';
import type { IdeState } from './ideState';
import type { IdeActions } from './menus';
import { memberCompletion } from './completions';
import { bpEffect, bpField, bpLines, toggleBreakpointAt } from './breakpoints';
import { SpanCache, editorLook, refreshHighlight, vbHighlight, vbTheme } from './vbLanguage';
import { collapseToDefinitions, indentGuides, outlining, procedureSeparator, revealEffects, toggleAllOutlining, toggleOutliningExpansion } from './vbOutlining';
import { editingHelpers, vbEnter, vbTab } from './vbEditing';
import { lineChanges } from './lineDiff';
import { exprAt } from './debugWindows';
import './codeWindow.css';

export interface CodeWindow {
  win: MdiWindow;
  gotoProcedure(objectName: string, eventName: string): void;
  gotoLine(line: number): void;
  setBreakLine(line: number | null): void;
  /** Call Stack > Show: the green triangle on the line of a calling procedure (null removes it). Optional for test doubles. */
  setCallLine?(line: number | null): void;
  markErrorLines(lines: number[]): void;
  /** One undo step (plan 05). */
  applyChange(from: number, to: number, text: string): void;
  getCursorLine(): number;
  /** The variable or `a.b` chain at the cursor (Quick Watch, Add Watch). Optional for test doubles. */
  exprAtCursor?(): string | null;
  /** The main selection (offsets into getSource()), or null when nothing is selected. Optional for test doubles. */
  getSelection?(): { from: number; to: number; text: string } | null;
  getSource(): string;
  /** F9: toggles the breakpoint on `line` (default: the cursor line); false when the line cannot have one. */
  toggleBreakpoint(line?: number): boolean;
  breakpointLines(): number[];
}
/** `dataTip`: break mode's data tip for an expression hovered in the code of a form/module (`x = 5`), or null. */
export interface CodeEnv { mdiHost: HTMLElement; actions?: IdeActions; dataTip?: (moduleName: string, expr: string) => string | null }

const GENERAL = '(General)', DECLS = '(Declarations)';
/** The events of the Class object in a class module's code window. */
const CLASS_EVENTS: EventDef[] = [{ name: 'Initialize', params: '' }, { name: 'Terminate', params: '' }];

/** An entry of the Object box: its events and the one the box jumps to. */
interface ObjInfo { name: string; events: EventDef[]; defaultEvent: string; isArray: boolean }

/** `Private WithEvents w As Worker` lines of a module: variable name and class name. */
function withEventsVars(code: string): { name: string; cls: string }[] {
  const out: { name: string; cls: string }[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:Private|Public|Dim)[ \t]+WithEvents[ \t]+([A-Za-z_]\w*)[ \t]+As[ \t]+([A-Za-z_][\w.]*)/gim)) out.push({ name: m[1], cls: m[2] });
  return out;
}

/** The `Event Name(params)` declarations of a class module's code. */
export function classEvents(code: string): EventDef[] {
  const out: EventDef[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:Public[ \t]+)?Event[ \t]+([A-Za-z_]\w*)[ \t]*(?:\(([^)]*)\))?/gim)) out.push({ name: m[1], params: (m[2] ?? '').trim() });
  return out;
}
const INTERNAL = Annotation.define<boolean>();   // prettify edits (no leave-line handling)
const EXTERNAL = Annotation.define<boolean>();   // reload from the model (not written back)

const errEffect = StateEffect.define<{ pos: number; on: boolean }[] | { replace: number[] }>();
const errDeco = Decoration.line({ class: 'cm-vb-error' });
const errField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(errEffect)) continue;
      if ('replace' in e.value) v = Decoration.set(e.value.replace.map(p => errDeco.range(p)), true);
      else for (const { pos, on } of e.value) {
        v = v.update({ filter: f => f !== pos });
        if (on) v = v.update({ add: [errDeco.range(pos)] });
      }
    }
    return v;
  },
  provide: f => EditorView.decorations.from(f),
});

const breakEffect = StateEffect.define<number | null>();
const breakField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    if (v !== null && tr.docChanged) v = tr.changes.mapPos(v);
    for (const e of tr.effects) if (e.is(breakEffect)) v = e.value;
    return v;
  },
});
const breakDeco = Decoration.line({ class: 'cm-vb-break' });
/** The line Call Stack > Show marks with a green triangle (a procedure that called the stopped one). */
const callEffect = StateEffect.define<number | null>();
const callField = StateField.define<number | null>({
  create: () => null,
  update(v, tr) {
    if (v !== null && tr.docChanged) v = tr.changes.mapPos(v);
    for (const e of tr.effects) if (e.is(callEffect)) v = e.value;
    return v;
  },
});
/** The margin indicator: the yellow-line arrow (or the green call-stack triangle), the breakpoint dot, or both. */
class MarginMarker extends GutterMarker {
  constructor(readonly arrow: boolean, readonly dot: boolean, readonly call = false) { super(); }
  override eq(o: MarginMarker) { return o.arrow === this.arrow && o.dot === this.dot && o.call === this.call; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-vb-mark';
    if (this.dot) s.appendChild(document.createElement('span')).className = 'cm-vb-bpdot';
    if (this.arrow || this.call) {
      const a = s.appendChild(document.createElement('span'));
      a.className = this.arrow ? 'cm-vb-arrow' : 'cm-vb-arrow cm-vb-callarrow';
      a.textContent = '▶';
    }
    return s;
  }
}
const arrow = new MarginMarker(true, false), dot = new MarginMarker(false, true), both = new MarginMarker(true, true);
const callMark = new MarginMarker(false, false, true), callDot = new MarginMarker(false, true, true);
const breakExt: Extension = [
  breakField, bpField, callField,
  EditorView.decorations.compute([breakField], s => {
    const p = s.field(breakField);
    return p === null ? Decoration.none : Decoration.set([breakDeco.range(s.doc.lineAt(p).from)]);
  }),
  gutter({
    class: 'cm-vb-margin',
    lineMarker: (v, line) => {
      const p = v.state.field(breakField);
      const isBreak = p !== null && v.state.doc.lineAt(p).from === line.from;
      const isBp = v.state.field(bpField).includes(line.from);
      const c = v.state.field(callField);
      if (!isBreak && c !== null && v.state.doc.lineAt(c).from === line.from) return isBp ? callDot : callMark;
      return isBreak ? (isBp ? both : arrow) : isBp ? dot : null;
    },
    lineMarkerChange: u => u.startState.field(breakField) !== u.state.field(breakField) || u.startState.field(bpField) !== u.state.field(bpField)
      || u.startState.field(callField) !== u.state.field(callField) || u.docChanged,
    initialSpacer: () => arrow,
    // a click in the margin toggles the line's breakpoint (VB6)
    domEventHandlers: { mousedown: (v, line) => { toggleBreakpointAt(v, v.state.doc.lineAt(line.from).number); return true; } },
  }),
];

/** Edit > Outlining and its Ctrl+M chords (Visual Studio). On a Mac these are the Control key: Cmd+M minimizes. */
const outliningKeys = [
  { key: 'Ctrl-m Ctrl-m', run: toggleOutliningExpansion },
  { key: 'Ctrl-m Ctrl-l', run: toggleAllOutlining },
  { key: 'Ctrl-m Ctrl-o', run: collapseToDefinitions },
];

const envs = new WeakMap<IdeState, CodeEnv>();
const windows = new WeakMap<IdeState, Map<string, CodeWindow>>();
/** Breakpoint lines of closed code windows (VB6 keeps them until the project is closed). */
const savedBps = new WeakMap<IdeState, { project: Project; lines: Map<string, number[]> }>();
function saved(ide: IdeState): Map<string, number[]> {
  let s = savedBps.get(ide);
  if (!s || s.project !== ide.project) savedBps.set(ide, s = { project: ide.project, lines: new Map() });
  return s.lines;
}

/** Breakpoint lines per form/module id (open and closed code windows), only items that have some. */
export function breakpointsOf(ide: IdeState): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [id, lines] of saved(ide)) if (lines.length) out.set(id, lines);
  for (const [id, w] of windows.get(ide) ?? []) {
    const lines = w.breakpointLines();
    if (lines.length) out.set(id, lines); else out.delete(id);
  }
  return out;
}

/** Debug > Clear All Breakpoints. */
export function clearAllBreakpoints(ide: IdeState): void {
  saved(ide).clear();
  for (const w of windows.get(ide)?.values() ?? []) (w as CodeWindow & { view: EditorView }).view.dispatch({ effects: bpEffect.of({ clear: true }) });
  ide.breakpointsChanged(false);
}

const notifyBreakpoints = (ide: IdeState) => ide.breakpointsChanged(breakpointsOf(ide).size > 0);
const norm = (s: string) => s.replace(/\r\n?/g, '\n');
const continues = (t: string) => /(^|\s)_\s*$/.test(t);

type Item = { name: string; code: string; controls?: FormDef['controls'] };
const itemOf = (ide: IdeState, id: string): Item | undefined =>
  ide.project.forms.find(f => f.id === id) ?? ide.project.modules.find(m => m.id === id);

/** `Text1.text` -> `Text1.Text` (and method / control spelling after `Me.` or the form name), from the control registry. */
export function fixMemberCase(line: string, formName: string, controls: { name: string; type: ControlType }[], formNames: string[] = []): string {
  let toks;
  try { toks = tokenize(line); } catch { return line; }
  const ctl = new Map(controls.map(c => [c.name.toLowerCase(), c]));
  const forms = new Set([formName, ...formNames].map(n => n.toLowerCase()));
  const isDot = (i: number) => toks[i]?.kind === 'op' && toks[i].text === '.';
  const ownerAt = (i: number): { type: ControlType; viaForm: boolean } | null => {
    if (toks[i]?.kind === 'op' && toks[i].text === ')') {   // `Text1(0)`: the owner is the name before the parentheses
      for (let d = 0, k = i; k >= 0; k--) {
        if (toks[k].kind === 'op' && toks[k].text === ')') d++;
        else if (toks[k].kind === 'op' && toks[k].text === '(' && --d === 0) return k > 0 ? ownerAt(k - 1) : null;
      }
      return null;
    }
    const t = toks[i];
    if (!t || (t.kind !== 'ident' && t.kind !== 'keyword') || t.suffix) return null;
    const low = t.text.toLowerCase();
    if (isDot(i - 1)) {
      const base = i >= 2 ? ownerAt(i - 2) : null;
      const c = ctl.get(low);
      return base?.viaForm && c ? { type: c.type, viaForm: false } : null;
    }
    if (low === 'me' || forms.has(low)) return { type: 'Form', viaForm: true };
    const c = ctl.get(low);
    return c ? { type: c.type, viaForm: false } : null;
  };
  const chars = line.split('');
  for (let i = 0; i + 2 < toks.length; i++) {
    if (!isDot(i + 1) || toks[i + 2].kind !== 'ident' || toks[i + 2].suffix) continue;
    const owner = ownerAt(i);
    if (!owner) continue;
    const m = toks[i + 2], low = m.text.toLowerCase();
    const def = CONTROL_TYPES[owner.type];
    const canon = (owner.viaForm ? controls.find(c => c.name.toLowerCase() === low)?.name : undefined)
      ?? getPropDef(owner.type, m.text)?.name
      ?? def.methods.find(x => x.name.toLowerCase() === low)?.name;
    if (canon && canon.length === m.text.length) for (let k = 0; k < canon.length; k++) chars[m.col - 1 + k] = canon[k];
  }
  return chars.join('');
}

/** The open code window of a form/module, or null. */
export function getCodeWindow(ide: IdeState, itemId: string): CodeWindow | null {
  return windows.get(ide)?.get(itemId) ?? null;
}

// ---- clipboard / edit commands on an EditorView (context menu, Edit menu and toolbar) --------------------------------
const clip = (): Clipboard | undefined => (globalThis.navigator as Navigator | undefined)?.clipboard;
const selectedText = (v: EditorView): string => { const r = v.state.selection.main; return v.state.sliceDoc(r.from, r.to); };

export async function editCopy(v: EditorView): Promise<void> {
  const t = selectedText(v);
  if (!t) { v.focus(); return; }
  const c = clip();
  let done = false;
  if (c?.writeText) { try { await c.writeText(t); done = true; } catch { /* fall back */ } }
  v.focus();
  if (!done) v.dom.ownerDocument.execCommand?.('copy');
}
export async function editCut(v: EditorView): Promise<void> {
  if (v.state.readOnly || !selectedText(v)) { v.focus(); return; }
  await editCopy(v);
  v.dispatch(v.state.replaceSelection(''));
  v.focus();
}
export async function editPaste(v: EditorView): Promise<void> {
  if (v.state.readOnly) { v.focus(); return; }
  const c = clip();
  if (c?.readText) {
    try { const t = await c.readText(); v.dispatch(v.state.replaceSelection(norm(t))); v.focus(); return; } catch { /* fall back */ }
  }
  v.focus();
  v.dom.ownerDocument.execCommand?.('paste');
}
export function editDelete(v: EditorView): void {
  if (!v.state.readOnly) deleteCharForward(v);
  v.focus();
}
export function editSelectAll(v: EditorView): void {
  v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  v.focus();
}

export function openCodeWindow(ide: IdeState, itemId: string, env?: CodeEnv): CodeWindow {
  if (env) envs.set(ide, env);
  let reg = windows.get(ide);
  if (!reg) windows.set(ide, reg = new Map());
  const existing = reg.get(itemId);
  if (existing) {
    existing.win.activate();
    ide.setActiveView({ kind: 'code', itemId });
    (existing as CodeWindow & { view: EditorView }).view.focus();
    return existing;
  }
  const item0 = itemOf(ide, itemId);
  if (!item0) throw new Error(`Code item not found: ${itemId}`);
  const host = (envs.get(ide) ?? (() => { const e = { mdiHost: document.body.appendChild(h('div')) }; envs.set(ide, e); return e; })()).mdiHost;

  const item = (): Item | undefined => itemOf(ide, itemId);
  const form = (): FormDef | undefined => ide.project.forms.find(f => f.id === itemId);
  const title = () => `${ide.project.name} - ${item()?.name ?? ''} (Code)`;
  const win = createMdiWindow(host, { title: title(), x: 40 + 24 * reg.size, y: 30 + 24 * reg.size, width: 560, height: 340, resizable: true });

  // ---- model helpers -------------------------------------------------------------------------------------------
  const controls = () => form()?.controls ?? [];
  const isClass = () => ide.project.modules.find(m => m.id === itemId)?.kind === 'class';
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  /** The module's WithEvents variables (forms and classes), with the events their class declares. */
  const eventVars = (): ObjInfo[] => {
    if (!form() && !isClass()) return [];
    return withEventsOfDoc().map(v => {
      const cls = ide.project.modules.find(m => m.kind === 'class' && m.name.toLowerCase() === v.cls.toLowerCase());
      const events = cls ? classEvents(cls.code) : [];
      return { name: v.name, events, defaultEvent: events[0]?.name ?? '', isArray: false };
    });
  };
  const objectNames = (): string[] => {
    const evs = eventVars().map(v => v.name);
    if (isClass()) return [GENERAL, 'Class', ...evs.sort(byName)];
    if (!form()) return [GENERAL];
    const seen = new Map<string, string>();
    for (const c of controls()) if (!seen.has(c.name.toLowerCase())) seen.set(c.name.toLowerCase(), c.name);
    for (const n of evs) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    return [GENERAL, formObjectName(form()), ...[...seen.values()].sort(byName)];
  };
  const objInfo = (obj: string): ObjInfo | null => {
    const low = obj.toLowerCase();
    if (isClass() && low === 'class') return { name: 'Class', events: CLASS_EVENTS, defaultEvent: 'Initialize', isArray: false };
    const f = form();
    if (f && (low === formObjectName(f).toLowerCase() || low === f.name.toLowerCase())) {
      return { name: formObjectName(f), events: formEvents(f), defaultEvent: CONTROL_TYPES.Form.defaultEvent, isArray: false };
    }
    const cs = controls().filter(c => c.name.toLowerCase() === low);
    if (cs.length) {
      const d = CONTROL_TYPES[cs[0].type];
      return { name: cs[0].name, events: d.events, defaultEvent: d.defaultEvent, isArray: cs.some(c => c.index !== null) };
    }
    return eventVars().find(v => v.name.toLowerCase() === low) ?? null;
  };
  /** (object, event) a procedure name stands for, else null (a general procedure). */
  const resolveProc = (name: string): { obj: string; ev: string } | null => {
    for (const o of objectNames().slice(1)) {
      if (!name.toLowerCase().startsWith(`${o.toLowerCase()}_`)) continue;
      const rest = name.slice(o.length + 1), t = objInfo(o)!;
      const ev = t.events.find(e => e.name.toLowerCase() === rest.toLowerCase());
      if (ev) return { obj: o, ev: ev.name };
    }
    return null;
  };

  // ---- editor ----------------------------------------------------------------------------------------------------
  let view!: EditorView;
  let prevHead = 0;
  let curObj = GENERAL;
  const objCombo: Combo = createCombo({ items: [GENERAL], value: GENERAL, onChange: o => {
    if (o === GENERAL) {
      curObj = o; fillProcs(); api.gotoLine(listProcedures(src())[0]?.line ?? 1);
    } else api.gotoProcedure(o, objInfo(o)?.defaultEvent ?? '');
  } });
  const procCombo: Combo = createCombo({ items: [DECLS], value: DECLS, onChange: p => {
    if (curObj === GENERAL) {
      const r = p === DECLS ? null : listProcedures(src()).find(x => procLabel(x) === p) ?? null;
      api.gotoLine(r ? Math.min(r.line + 1, r.endLine) : 1);
    } else api.gotoProcedure(curObj, p);
  } });
  const src = () => view.state.doc.toString();
  let synced: string | null = null;   // it.code as of the editor's last write / load (the doc holds norm(synced))
  // parsed once per doc version: the combos are synced on every IDE command
  const perDoc = <T>(parse: (text: string) => T): (() => T) => {
    let doc: EditorState['doc'] | null = null, out: T;
    return () => {
      if (view.state.doc !== doc) { doc = view.state.doc; out = parse(doc.toString()); }
      return out;
    };
  };
  const procsOfDoc = perDoc(listProcedures), withEventsOfDoc = perDoc(withEventsVars);
  function fillProcs(procs = procsOfDoc()): void {
    if (curObj === GENERAL) procCombo.setItems([DECLS, ...procs.filter(p => p.property || !resolveProc(p.name)).map(procLabel)], () => false);
    else {
      const t = objInfo(curObj);
      const have = new Set(procs.map(p => p.name.toLowerCase()));
      procCombo.setItems((t?.events ?? []).map(e => e.name), e => have.has(`${curObj}_${e}`.toLowerCase()));
    }
  }
  function syncCombos(): void {
    objCombo.setItems(objectNames());
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const procs = procsOfDoc();
    const p = procs.find(x => line >= x.line && line <= x.endLine);
    const r = p && !p.property ? resolveProc(p.name) : null;
    curObj = r ? r.obj : GENERAL;
    objCombo.setValue(curObj);
    fillProcs(procs);
    procCombo.setValue(r ? r.ev : p ? procLabel(p) : DECLS);
  }

  const known = (): Map<string, string> => {
    const m = collectIdentifiers(src());
    const f = form();
    for (const c of controls()) m.set(c.name.toLowerCase(), c.name);
    for (const fm of ide.project.forms) m.set(fm.name.toLowerCase(), fm.name);
    if (f) m.set(formObjectName(f).toLowerCase(), formObjectName(f));
    return m;
  };
  const logicalRange = (doc: EditorState['doc'], n: number): [number, number] => {
    let a = n, b = n;
    while (a > 1 && continues(doc.line(a - 1).text)) a--;
    while (b < doc.lines && continues(doc.line(b).text)) b++;
    return [a, b];
  };

  function leaveLine(v: EditorView, n: number, newLine: number): void {
    if (n > v.state.doc.lines || v.state.readOnly) return;   // run / break mode: no prettifying, no syntax check
    const line = v.state.doc.line(n);
    let text = prettifyLine(line.text, known());
    text = fixMemberCase(text, form()?.name ?? '', controls().map(c => ({ name: c.name, type: c.type })), ide.project.forms.map(f => f.name));
    if (text !== line.text) {
      let s = 0;
      while (s < text.length && s < line.text.length && text[s] === line.text[s]) s++;
      let e = 0;
      while (e < text.length - s && e < line.text.length - s && text[text.length - 1 - e] === line.text[line.text.length - 1 - e]) e++;
      v.dispatch({ changes: { from: line.from + s, to: line.to - e, insert: text.slice(s, text.length - e) }, annotations: INTERNAL.of(true) });
    }
    if (!ide.options.autoSyntaxCheck) return;
    const doc = v.state.doc;
    const [a, b] = logicalRange(doc, n);
    if ((newLine >= a && newLine <= b) || continues(doc.line(b).text)) return;   // still inside the logical line
    const lines: number[] = [];
    for (let i = a; i <= b; i++) lines.push(doc.line(i).from);
    const code = Array.from({ length: b - a + 1 }, (_, i) => doc.line(a + i).text).join('\n');
    let err = null;
    try { err = checkLineSyntax(code); } catch { /* not a syntax error: ignore */ }
    v.dispatch({ effects: errEffect.of(lines.map(pos => ({ pos, on: !!err }))), annotations: INTERNAL.of(true) });
    if (err) void compileErrorBox(v.dom.ownerDocument, err.message).then(() => v.focus());
  }

  /** Tells the IDE (menu / toolbar enabled state) whether this window's editor has a selection. */
  const syncSelection = (v: EditorView) => {
    const a = ide.activeView;
    if (a.kind === 'code' && a.itemId === itemId) ide.setCodeSelection(!v.state.selection.main.empty);
  };
  function onTransaction(tr: Transaction, v: EditorView): void {
    if (tr.effects.some(e => e.is(bpEffect)) || tr.startState.field(bpField).length !== tr.state.field(bpField).length) notifyBreakpoints(ide);
    if (tr.docChanged && !tr.annotation(EXTERNAL)) {
      const it = item();
      if (it) { it.code = synced = src(); ide.stack.markDirtyExternal(); }
    }
    if (!tr.docChanged && !tr.selection && !tr.annotation(EXTERNAL)) return;
    syncSelection(v);
    const head = v.state.selection.main.head;
    const was = tr.annotation(INTERNAL) || tr.annotation(EXTERNAL) ? null : tr.changes.mapPos(prevHead, -1);
    const before = was === null ? null : v.state.doc.lineAt(Math.min(was, v.state.doc.length)).number;
    const now = v.state.doc.lineAt(head).number;
    prevHead = head;
    if (before !== null && before !== now) leaveLine(v, before, now);
    prevHead = v.state.selection.main.head;
    syncCombos();
  }

  // Read-only in run and break mode (edit-and-continue comes in phase 6)
  const lockExt = (): Extension => [EditorState.readOnly.of(ide.mode !== 'design'), EditorView.editable.of(ide.mode === 'design')];
  const lock = new Compartment();
  // Tools > Options: palette, font size, procedure separator
  const look = new Compartment(), separator = new Compartment();
  const lookExt = (): Extension => editorLook(ide.options.codePalette === 'vb6' ? 'vb6' : 'vs', Math.min(16, Math.max(9, Math.round(ide.options.codeFontSize) || 13)));
  const sepExt = (): Extension => (ide.options.procedureSeparator ? procedureSeparator : []);
  // control and form names (coloured like VS user types)
  const spans = new SpanCache(() => new Set([...controls().map(c => c.name.toLowerCase()), ...ide.project.forms.map(f => f.name.toLowerCase())]));
  // break mode: hovering a variable or obj.Property shows its value (a selection hovered shows the selected expression)
  const dataTips = hoverTooltip((v, pos) => {
    const tip = envs.get(ide)?.dataTip;
    const name = item()?.name;
    if (ide.mode !== 'break' || !tip || !name) return null;
    const sel = v.state.selection.main;
    const line = v.state.doc.lineAt(pos);
    let r: { from: number; to: number; text: string } | null;
    if (!sel.empty && pos >= sel.from && pos <= sel.to && v.state.doc.lineAt(sel.from).number === v.state.doc.lineAt(sel.to).number) {
      r = { from: sel.from, to: sel.to, text: v.state.sliceDoc(sel.from, sel.to).trim() };
    } else {
      const e = exprAt(line.text, pos - line.from);
      r = e && { from: line.from + e.from, to: line.from + e.to, text: e.text };
    }
    const text = r && r.text ? tip(name, r.text) : null;
    if (!r || !text) return null;
    return { pos: r.from, end: r.to, above: false, create: () => ({ dom: h('div', { class: 'cm-vb-datatip' }, text) }) };
  }, { hoverTime: 400 });
  const state = EditorState.create({
    doc: norm(item0.code),
    extensions: [
      lock.of(lockExt()),
      history(), search({ top: true }),
      autocompletion({ override: [memberCompletion(() => form() ?? null, () => ({
        classes: new Map(ide.project.modules.filter(m => m.kind === 'class').map(m => [m.name.toLowerCase(), m.code])),
        self: isClass() ? item()?.name.toLowerCase() ?? null : null,
      }))], icons: false }),
      vbHighlight(spans), vbTheme, look.of(lookExt()), errField, breakExt, outlining, separator.of(sepExt()), indentGuides, editingHelpers(spans),
      keymap.of([
        { key: 'Enter', run: vbEnter }, { key: 'Tab', run: c => acceptCompletion(c) || vbTab(c) }, { key: 'Shift-Tab', run: indentLess },
        ...outliningKeys,
        // before defaultKeymap: its Mod-i (selectParentSyntax) would swallow Cmd+I (Tools > Ask AI...)
        { key: 'Mod-i', run: () => { envs.get(ide)?.actions?.askAi?.(); return true; } },
        // historyKeymap redoes with Cmd+Shift+Z on a Mac; Edit > Redo's Ctrl+Y (Cmd+Y) is left to editable targets
        { key: 'Mod-y', run: redo, preventDefault: true },
        // Ctrl-m (tab focus mode) would clash with the Ctrl+M outlining chords, Mod-l (select line) with View > Call Stack
        ...searchKeymap, ...historyKeymap, ...defaultKeymap.filter(b => b.key !== 'Ctrl-m' && b.key !== 'Mod-l'),
      ]),
      dataTips,
    ],
  });
  const editorEl = h('div', { class: 'cw-editor' });
  win.body.append(h('div', { class: 'cw-root' }, h('div', { class: 'cw-bar' }, objCombo.el, procCombo.el), editorEl));
  view = new EditorView({ state, parent: editorEl, dispatch: (tr, v) => { v.update([tr]); onTransaction(tr, v); } });
  syncCombos();
  // breakpoints of this module from when its window was last open
  const kept = saved(ide).get(itemId);
  if (kept) {
    view.dispatch({ effects: kept.filter(n => n <= view.state.doc.lines).map(n => bpEffect.of({ toggle: view.state.doc.line(n).from })) });
    saved(ide).delete(itemId);
  }
  // Right-click: Cut / Copy / Paste / Select All (+ Ask AI... in design mode); Copy and Select All only in run/break mode.
  const copy = () => editCopy(view), cut = () => editCut(view), paste = () => editPaste(view);
  const selectAll = () => editSelectAll(view);
  editorEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    const askAi = envs.get(ide)?.actions?.askAi;
    const items: PopupItem[] = ide.mode === 'design'
      ? [{ label: 'Cut', action: () => { void cut(); } }, { label: 'Copy', action: () => { void copy(); } },
        { label: 'Paste', action: () => { void paste(); } }, { label: 'Select All', action: selectAll },
        ...(askAi ? [{ separator: true } as const, { label: 'Ask AI...', action: () => askAi() }] : [])]
      : [{ label: 'Copy', action: () => { void copy(); } }, { label: 'Select All', action: selectAll }];
    popupMenu(editorEl.ownerDocument, e.clientX, e.clientY, items);
  });

  // ---- window / model sync -----------------------------------------------------------------------------------------
  const setActive = () => { ide.setActiveView({ kind: 'code', itemId }); if (view) syncSelection(view); };
  win.el.addEventListener('focusin', setActive);
  win.el.addEventListener('mousedown', setActive);
  const onProject = () => {
    const it = item();
    if (!it) { win.close(); return; }
    win.setTitle(title());
    // the model's code is still the text the editor last wrote or loaded: no full-text compare per command
    const changed = it.code !== synced;
    synced = it.code;
    const code = changed ? norm(it.code) : '', cur = changed ? src() : '';
    if (code !== cur) {
      let s = 0;
      while (s < code.length && s < cur.length && code[s] === cur[s]) s++;
      let e = 0;
      while (e < code.length - s && e < cur.length - s && code[code.length - 1 - e] === cur[cur.length - 1 - e]) e++;
      const sel = view.state.selection.main;
      const clamp = (p: number) => Math.min(p, code.length);
      view.dispatch({
        changes: { from: s, to: cur.length - e, insert: code.slice(s, code.length - e) },
        selection: { anchor: clamp(sel.anchor), head: clamp(sel.head) }, annotations: EXTERNAL.of(true),
      });
    } else syncCombos();
    view.dispatch({ effects: refreshHighlight.of(null) });   // a renamed control / form changes the colours
  };
  const unsubProject = ide.on('project', onProject);
  const unsubClose = ide.on('closeWindows', () => win.close());
  const unsubMode = ide.on('mode', () => { if (!closed) view.dispatch({ effects: lock.reconfigure(lockExt()) }); });
  const unsubOptions = ide.on('options', () => {
    if (!closed) view.dispatch({ effects: [look.reconfigure(lookExt()), separator.reconfigure(sepExt())] });
  });
  const unsub = () => { unsubProject(); unsubClose(); unsubMode(); unsubOptions(); };
  let closed = false;
  win.onClose = () => {
    closed = true; unsub(); reg!.delete(itemId);
    const lines = bpLines(view.state);
    if (lines.length) saved(ide).set(itemId, lines);
    view.destroy();
    return true;
  };

  // ---- API ---------------------------------------------------------------------------------------------------------
  const lineStart = (n: number) => view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines))).from;
  const api: CodeWindow = {
    win,
    gotoLine(n) {
      // a line inside a folded block is shown first (break mode, errors, the procedure dropdown)
      view.dispatch({ effects: revealEffects(view.state, lineStart(n)), selection: { anchor: lineStart(n) }, scrollIntoView: true });
      view.focus();
    },
    gotoProcedure(objectName, eventName) {
      if (closed) return;
      let name = eventName;
      if (objectName !== GENERAL) {
        const t = objInfo(objectName);
        const ev = t && t.events.find(e => e.name.toLowerCase() === eventName.toLowerCase());
        if (!t || !ev) return;
        name = `${t.name}_${ev.name}`;
        if (!findProcedureRange(src(), name)) {
          if (view.state.readOnly) return;   // run / break mode: only an existing procedure is shown, no stub is added
          const r = insertProcedure(src(), buildEventStub(t.name, t.isArray, ev));
          const baseLen = src().replace(/\s+$/, '').length;
          view.dispatch({
            changes: { from: baseLen, to: view.state.doc.length, insert: r.source.slice(baseLen) },
            selection: { anchor: lineStartIn(r.source, r.cursorLine) }, scrollIntoView: true,
          });
          view.focus();
          return;
        }
      }
      const r = findProcedureRange(src(), name);
      if (r) api.gotoLine(Math.min(r.line + 1, r.endLine));
    },
    setBreakLine(n) {
      view.dispatch({ effects: [breakEffect.of(n === null ? null : lineStart(n)), ...(n === null ? [] : revealEffects(view.state, lineStart(n)))], scrollIntoView: false });
      if (n !== null) view.dispatch({ effects: EditorView.scrollIntoView(lineStart(n), { y: 'center' }) });
    },
    setCallLine(n) {
      if (!closed) view.dispatch({ effects: callEffect.of(n === null ? null : lineStart(n)) });
    },
    markErrorLines(lines) {
      view.dispatch({ effects: errEffect.of({ replace: lines.filter(n => n >= 1 && n <= view.state.doc.lines).map(lineStart) }), annotations: INTERNAL.of(true) });
    },
    // only the lines that differ change: breakpoints, folds and the cursor on untouched lines stay (review 08 final #2)
    applyChange(from, to, text) { view.dispatch({ changes: lineChanges(src(), from, to, norm(text)) }); },
    getCursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    exprAtCursor: () => {
      const head = view.state.selection.main.head, line = view.state.doc.lineAt(head);
      return exprAt(line.text, head - line.from)?.text ?? null;
    },
    getSelection: () => { const r = view.state.selection.main; return r.empty ? null : { from: r.from, to: r.to, text: view.state.sliceDoc(r.from, r.to) }; },
    getSource: () => src(),
    toggleBreakpoint: line => toggleBreakpointAt(view, line ?? api.getCursorLine()),
    breakpointLines: () => bpLines(view.state),
  };
  const lineStartIn = (s: string, n: number) => s.split('\n').slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
  (api as CodeWindow & { view: EditorView }).view = view;
  reg.set(itemId, api);
  setActive();
  view.focus();
  return api;
}

/** Registers `viewCode` (F7), `viewObject` (Shift+F7) and `find` for code windows. */
export function registerCodeActions(ide: IdeState, actions: IdeActions, env: CodeEnv): void {
  envs.set(ide, env);
  const activeId = (): string | null => {
    const v = ide.activeView;
    return v.kind === 'designer' ? v.formId : v.kind === 'code' ? v.itemId : ide.project.forms[0]?.id ?? null;
  };
  actions.viewCode = (itemId?: string, objectName?: string, eventName?: string) => {
    const id = itemId ?? activeId();
    if (!id || !itemOf(ide, id)) return;
    const w = openCodeWindow(ide, id, env);
    if (objectName && eventName) w.gotoProcedure(objectName, eventName);
    else (w as CodeWindow & { view: EditorView }).view.focus();
  };
  actions.viewObject = () => {
    const v = ide.activeView;
    const id = v.kind === 'code' ? v.itemId : v.kind === 'designer' ? v.formId : null;
    if (id && ide.project.forms.some(f => f.id === id)) openDesigner(ide, id, env);
  };
  const viewOf = (): EditorView | null => {
    const v = ide.activeView;
    const w = v.kind === 'code' ? windows.get(ide)?.get(v.itemId) : undefined;
    return w ? (w as CodeWindow & { view: EditorView }).view : null;
  };
  // Undo / Redo belong to the text editor while a code window is active, else to the project command stack
  for (const [name, cmd] of [['undo', undo], ['redo', redo]] as const) {
    const prev = actions[name];
    actions[name] = (...a: unknown[]) => { const v = viewOf(); if (v) cmd(v); else prev?.(...a); };
  }
  // Edit commands: one dispatcher per action; the active code window's editor wins, else the designer's handler
  const edits: [string, (v: EditorView) => unknown][] = [
    ['cut', editCut], ['copy', editCopy], ['paste', editPaste], ['delete', editDelete], ['selectAll', editSelectAll],
  ];
  for (const [name, fn] of edits) {
    const prev = actions[name];
    actions[name] = (...a: unknown[]) => { const v = viewOf(); if (v) void fn(v); else prev?.(...a); };
  }
  actions.find = () => {
    const v = viewOf();
    if (v) openSearchPanel(v);
  };
  actions.toggleBreakpoint = () => {
    const v = ide.activeView;
    if (v.kind === 'code') windows.get(ide)?.get(v.itemId)?.toggleBreakpoint();
  };
  actions.clearAllBreakpoints = () => clearAllBreakpoints(ide);
  // Edit > Outlining
  for (const [name, cmd] of [['toggleOutlining', toggleOutliningExpansion], ['toggleAllOutlining', toggleAllOutlining],
    ['collapseToDefinitions', collapseToDefinitions]] as const) {
    actions[name] = () => { const v = viewOf(); if (v) { cmd(v); v.focus(); } };
  }
  // a new project has no breakpoints
  ide.on('project', () => { if (ide.hasBreakpoints && breakpointsOf(ide).size === 0) ide.breakpointsChanged(false); });
}
