// The code window: one CodeMirror 6 editor per form/module (Full Module View) with Object/Procedure dropdowns.
// Leaving a line prettifies it (plan 01 prettifyLine + control property spelling) and, when Auto Syntax Check is on,
// marks it red and shows the compile error box. Edits write form.code / module.code and mark the project dirty.
import { Annotation, Compartment, EditorState, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineKeepIndent, insertTab, indentLess, undo, redo, deleteCharForward } from '@codemirror/commands';
import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { tokenize } from '../lang/lexer';
import { checkLineSyntax } from '../lang/parser';
import { collectIdentifiers, prettifyLine } from '../lang/prettify';
import { CONTROL_TYPES, getPropDef } from '../model/controls';
import { buildEventStub, findProcedureRange, insertProcedure, listProcedures } from '../model/procedures';
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
import { vbHighlight, vbTheme } from './vbLanguage';
import './codeWindow.css';

export interface CodeWindow {
  win: MdiWindow;
  gotoProcedure(objectName: string, eventName: string): void;
  gotoLine(line: number): void;
  setBreakLine(line: number | null): void;
  markErrorLines(lines: number[]): void;
  /** One undo step (plan 05). */
  applyChange(from: number, to: number, text: string): void;
  getCursorLine(): number;
  /** The main selection (offsets into getSource()), or null when nothing is selected. Optional for test doubles. */
  getSelection?(): { from: number; to: number; text: string } | null;
  getSource(): string;
  /** F9: toggles the breakpoint on `line` (default: the cursor line); false when the line cannot have one. */
  toggleBreakpoint(line?: number): boolean;
  breakpointLines(): number[];
}
export interface CodeEnv { mdiHost: HTMLElement; actions?: IdeActions }

const GENERAL = '(General)', DECLS = '(Declarations)';
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
/** The margin indicator: the yellow-line arrow, the breakpoint dot, or both. */
class MarginMarker extends GutterMarker {
  constructor(readonly arrow: boolean, readonly dot: boolean) { super(); }
  override eq(o: MarginMarker) { return o.arrow === this.arrow && o.dot === this.dot; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-vb-mark';
    if (this.dot) s.appendChild(document.createElement('span')).className = 'cm-vb-bpdot';
    if (this.arrow) { const a = s.appendChild(document.createElement('span')); a.className = 'cm-vb-arrow'; a.textContent = '▶'; }
    return s;
  }
}
const arrow = new MarginMarker(true, false), dot = new MarginMarker(false, true), both = new MarginMarker(true, true);
const breakExt: Extension = [
  breakField, bpField,
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
      return isBreak ? (isBp ? both : arrow) : isBp ? dot : null;
    },
    lineMarkerChange: u => u.startState.field(breakField) !== u.state.field(breakField) || u.startState.field(bpField) !== u.state.field(bpField) || u.docChanged,
    initialSpacer: () => arrow,
    // a click in the margin toggles the line's breakpoint (VB6)
    domEventHandlers: { mousedown: (v, line) => { toggleBreakpointAt(v, v.state.doc.lineAt(line.from).number); return true; } },
  }),
];

// thin grey rule under every End Sub / End Function
const procEndExt = EditorView.decorations.compute(['doc'], s => {
  const ends = listProcedures(s.doc.toString()).filter(p => p.endLine < s.doc.lines);
  return Decoration.set(ends.map(p => Decoration.line({ class: 'cm-vb-procend' }).range(s.doc.line(p.endLine).from)));
});

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
  const objectNames = (): string[] => {
    if (!form()) return [GENERAL];
    const seen = new Map<string, string>();
    for (const c of controls()) if (!seen.has(c.name.toLowerCase())) seen.set(c.name.toLowerCase(), c.name);
    return [GENERAL, 'Form', ...[...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))];
  };
  const typeOf = (obj: string): { type: ControlType; name: string; isArray: boolean } | null => {
    const f = form();
    if (!f) return null;
    const low = obj.toLowerCase();
    if (low === 'form' || low === f.name.toLowerCase()) return { type: 'Form', name: 'Form', isArray: false };
    const cs = controls().filter(c => c.name.toLowerCase() === low);
    return cs.length ? { type: cs[0].type, name: cs[0].name, isArray: cs.some(c => c.index !== null) } : null;
  };
  /** (object, event) a procedure name stands for, else null (a general procedure). */
  const resolveProc = (name: string): { obj: string; ev: string } | null => {
    for (const o of objectNames().slice(1)) {
      if (!name.toLowerCase().startsWith(`${o.toLowerCase()}_`)) continue;
      const rest = name.slice(o.length + 1), t = typeOf(o)!;
      const ev = CONTROL_TYPES[t.type].events.find(e => e.name.toLowerCase() === rest.toLowerCase());
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
    } else api.gotoProcedure(o, CONTROL_TYPES[typeOf(o)?.type ?? 'Form'].defaultEvent);
  } });
  const procCombo: Combo = createCombo({ items: [DECLS], value: DECLS, onChange: p => {
    if (curObj === GENERAL) {
      const r = p === DECLS ? null : findProcedureRange(src(), p);
      api.gotoLine(r ? Math.min(r.line + 1, r.endLine) : 1);
    } else api.gotoProcedure(curObj, p);
  } });
  const src = () => view.state.doc.toString();
  const generalProcs = () => listProcedures(src()).filter(p => !resolveProc(p.name)).map(p => p.name);
  function fillProcs(): void {
    if (curObj === GENERAL) procCombo.setItems([DECLS, ...generalProcs()], () => false);
    else {
      const t = typeOf(curObj);
      const s = src();
      procCombo.setItems((t ? CONTROL_TYPES[t.type].events : []).map(e => e.name), e => !!findProcedureRange(s, `${curObj}_${e}`));
    }
  }
  function syncCombos(): void {
    objCombo.setItems(objectNames());
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const p = listProcedures(src()).find(x => line >= x.line && line <= x.endLine);
    const r = p ? resolveProc(p.name) : null;
    curObj = r ? r.obj : GENERAL;
    objCombo.setValue(curObj);
    fillProcs();
    procCombo.setValue(r ? r.ev : p ? p.name : DECLS);
  }

  const known = (): Map<string, string> => {
    const m = collectIdentifiers(src());
    const f = form();
    for (const c of controls()) m.set(c.name.toLowerCase(), c.name);
    for (const fm of ide.project.forms) m.set(fm.name.toLowerCase(), fm.name);
    if (f) m.set('form', 'Form');
    return m;
  };
  const logicalRange = (doc: EditorState['doc'], n: number): [number, number] => {
    let a = n, b = n;
    while (a > 1 && continues(doc.line(a - 1).text)) a--;
    while (b < doc.lines && continues(doc.line(b).text)) b++;
    return [a, b];
  };

  function leaveLine(v: EditorView, n: number, newLine: number): void {
    if (n > v.state.doc.lines) return;
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
      if (it) { it.code = src(); ide.stack.markDirtyExternal(); }
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
  const state = EditorState.create({
    doc: norm(item0.code),
    extensions: [
      lock.of(lockExt()),
      history(), search({ top: true }),
      autocompletion({ override: [memberCompletion(() => form() ?? null)], icons: false }),
      vbHighlight, vbTheme, errField, breakExt, procEndExt,
      keymap.of([
        { key: 'Enter', run: insertNewlineKeepIndent }, { key: 'Tab', run: c => acceptCompletion(c) || insertTab(c) }, { key: 'Shift-Tab', run: indentLess },
        // before defaultKeymap: its Mod-i (selectParentSyntax) would swallow Cmd+I (Tools > Ask AI...)
        { key: 'Mod-i', run: () => { envs.get(ide)?.actions?.askAi?.(); return true; } },
        ...searchKeymap, ...historyKeymap, ...defaultKeymap,
      ]),
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
    const code = norm(it.code), cur = src();
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
  };
  const unsubProject = ide.on('project', onProject);
  const unsubClose = ide.on('closeWindows', () => win.close());
  const unsubMode = ide.on('mode', () => { if (!closed) view.dispatch({ effects: lock.reconfigure(lockExt()) }); });
  const unsub = () => { unsubProject(); unsubClose(); unsubMode(); };
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
      view.dispatch({ selection: { anchor: lineStart(n) }, scrollIntoView: true });
      view.focus();
    },
    gotoProcedure(objectName, eventName) {
      if (closed) return;
      let name = eventName;
      if (objectName !== GENERAL) {
        const t = typeOf(objectName);
        const ev = t && CONTROL_TYPES[t.type].events.find(e => e.name.toLowerCase() === eventName.toLowerCase());
        if (!t || !ev) return;
        name = `${t.name}_${ev.name}`;
        if (!findProcedureRange(src(), name)) {
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
      view.dispatch({ effects: breakEffect.of(n === null ? null : lineStart(n)), scrollIntoView: false });
      if (n !== null) view.dispatch({ effects: EditorView.scrollIntoView(lineStart(n), { y: 'center' }) });
    },
    markErrorLines(lines) {
      view.dispatch({ effects: errEffect.of({ replace: lines.filter(n => n >= 1 && n <= view.state.doc.lines).map(lineStart) }), annotations: INTERNAL.of(true) });
    },
    applyChange(from, to, text) { view.dispatch({ changes: { from, to, insert: text } }); },
    getCursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
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
  // a new project has no breakpoints
  ide.on('project', () => { if (ide.hasBreakpoints && breakpointsOf(ide).size === 0) ide.breakpointsChanged(false); });
}
