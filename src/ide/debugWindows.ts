// VB6 break-mode debugging in the IDE: the Locals and Watches windows (docked below the code, next to Immediate), the
// Add / Edit / Quick Watch and Call Stack dialogs, data tips and Set / Show Next Statement. The values come from
// Program.debug (lang/interp/debugger.ts); an edited value is assigned through the Immediate window's evaluator.
import { OUT_OF_CONTEXT, valueText, type DebugNode, type MemberLister, type ProgramDebugger, type StackEntry } from '../lang/interp/debugger';
import { isObject, VBArray, VBRecord, vbTypeName } from '../lang/values';
import { CONTROL_TYPES, type ControlTypeDef } from '../model/controls';
import { listProcedures } from '../model/procedures';
import type { WatchDef } from '../model/types';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { h } from '../ui98/dom';
import { popupMenu } from '../ui98/popup';
import type { IdeState } from './ideState';
import type { IdeActions } from './menus';
import './debugWindows.css';

// ---------------------------------------------------------------------------------------------------------------------
// The expression under the mouse (data tips, Quick Watch, Add Watch)

const ID = /[A-Za-z0-9_]/;

/** The variable or `a.b.c` chain at column `col` of a code line (not in a string or comment), or null. */
export function exprAt(text: string, col: number): { from: number; to: number; text: string } | null {
  if (/^\s*rem(\s|$)/i.test(text)) return null;
  let inStr = false;
  for (let i = 0; i < col && i < text.length; i++) {
    if (text[i] === '"') inStr = !inStr;
    else if (!inStr && text[i] === '\'') return null;
  }
  if (inStr) return null;
  const isId = (i: number) => i >= 0 && i < text.length && ID.test(text[i]);
  let s = isId(col) ? col : isId(col - 1) ? col - 1 : -1;
  if (s < 0) return null;
  while (isId(s - 1)) s--;
  let e = s;
  while (isId(e)) e++;
  if (/[$%&!#@]/.test(text[e] ?? '') && !isId(e + 1)) e++;   // a type suffix (s$)
  if (/\d/.test(text[s])) return null;
  let from = s;
  while (text[from - 1] === '.' && isId(from - 2)) {
    let k = from - 2;
    while (isId(k - 1)) k--;
    if (/\d/.test(text[k])) break;
    from = k;
  }
  if (text[from - 1] === '.') return null;   // a With member (`.Caption`) or after an index (`a(1).b`)
  return { from, to: e, text: text.slice(from, e) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tree list (Expression | Value | Type [| Context])

interface Root { node: DebugNode; key: string; extra?: string; tag?: number }
interface Row { node: DebugNode; key: string; depth: number; root: Root }

interface TreeOptions {
  /** Double-click on an editable value, edited and entered. */
  onEdit(node: DebugNode, text: string): void;
  onKey?(e: KeyboardEvent, row: Row | null): void;
  onContext?(e: MouseEvent, row: Row | null): void;
  onNameDblClick?(row: Row): void;
}

class TreeList {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly expanded = new Set<string>();
  private roots: Root[] = [];
  private rows: Row[] = [];
  selected: string | null = null;

  constructor(private readonly cols: string[], private readonly o: TreeOptions) {
    const head = h('div', { class: 'dbg98-head' }, ...cols.map((c, i) => h('div', { class: `dbg98-cell dbg98-c${i}` }, c)));
    this.body = h('div', { class: 'dbg98-body', tabindex: '0' });
    this.el = h('div', { class: `dbg98-tree dbg98-cols${cols.length}` }, head, this.body);
    this.body.addEventListener('keydown', e => {
      const row = this.rows.find(r => r.key === this.selected) ?? null;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && this.rows.length) {
        e.preventDefault();
        const i = row ? this.rows.indexOf(row) : -1;
        this.select(this.rows[Math.max(0, Math.min(this.rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].key);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && row?.node.children) {
        e.preventDefault();
        this.toggle(row.key, e.key === 'ArrowRight');
      } else this.o.onKey?.(e, row);
    });
    this.body.addEventListener('contextmenu', e => {
      e.preventDefault();
      const key = (e.target as HTMLElement).closest<HTMLElement>('.dbg98-row')?.dataset.key ?? null;
      if (key) this.select(key);
      this.o.onContext?.(e, this.rows.find(r => r.key === key) ?? null);
    });
  }

  set(roots: Root[]): void {
    this.roots = roots;
    this.render();
  }

  private select(key: string | null): void {
    this.selected = key;
    for (const el of this.body.querySelectorAll<HTMLElement>('.dbg98-row')) el.classList.toggle('selected', el.dataset.key === key);
  }

  private toggle(key: string, open = !this.expanded.has(key)): void {
    if (open) this.expanded.add(key); else this.expanded.delete(key);
    this.render();
  }

  selectedRow(): Row | null { return this.rows.find(r => r.key === this.selected) ?? null; }

  private render(): void {
    const rows: Row[] = [];
    const add = (node: DebugNode, key: string, depth: number, root: Root) => {
      rows.push({ node, key, depth, root });
      if (node.children && this.expanded.has(key)) {
        let kids: DebugNode[];
        try { kids = node.children(); } catch { kids = []; }
        for (const c of kids) add(c, `${key}/${c.expr}`, depth + 1, root);
      }
    };
    for (const r of this.roots) add(r.node, r.key, 0, r);
    this.rows = rows;
    if (!rows.some(r => r.key === this.selected)) this.selected = null;
    this.body.replaceChildren(...rows.map(r => this.rowEl(r)));
  }

  private rowEl(r: Row): HTMLElement {
    const n = r.node;
    const tog = h('span', { class: n.children ? 'dbg98-tog' : 'dbg98-tog empty' }, n.children ? (this.expanded.has(r.key) ? '−' : '+') : '');
    tog.addEventListener('mousedown', e => { e.preventDefault(); if (n.children) this.toggle(r.key); });
    const name = h('div', { class: 'dbg98-cell dbg98-c0', style: `padding-left:${2 + r.depth * 12}px`, title: n.name }, tog, n.name);
    const value = h('div', { class: n.editable ? 'dbg98-cell dbg98-c1 editable' : 'dbg98-cell dbg98-c1', title: n.value }, n.value);
    const cells = [name, value, h('div', { class: 'dbg98-cell dbg98-c2' }, n.type)];
    if (this.cols.length > 3) cells.push(h('div', { class: 'dbg98-cell dbg98-c3' }, r.depth === 0 ? r.root.extra ?? '' : ''));
    const el = h('div', { class: r.key === this.selected ? 'dbg98-row selected' : 'dbg98-row', 'data-key': r.key }, ...cells);
    el.addEventListener('mousedown', () => { this.select(r.key); this.body.focus(); });
    name.addEventListener('dblclick', () => this.o.onNameDblClick?.(r));
    value.addEventListener('dblclick', () => { if (n.editable) this.edit(value, n); });
    return el;
  }

  private edit(cell: HTMLElement, n: DebugNode): void {
    const input = h('input', { type: 'text', class: 'dbg98-edit', value: n.value }) as HTMLInputElement;
    cell.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done = true; this.o.onEdit(n, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; this.render(); }
    });
    input.addEventListener('blur', () => { if (!done) { done = true; this.render(); } });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Locals and Watches windows

/** The program in break mode as the windows see it (a RunSession in the IDE). */
export interface DebugTarget {
  debug: ProgramDebugger;
  /** The Immediate window: an edited value is assigned with `expr = text`. */
  immediate(text: string): Promise<string>;
}

export interface DebugDeps {
  /** The running program, or null in design mode. */
  target(): DebugTarget | null;
  inBreak(): boolean;
  projectName(): string;
  members: MemberLister;
  doc: Document;
  /** After an edited value was assigned: every debug window shows the new values. */
  changed(): void;
}

/** The properties of a form or control (from the control registry) shown when its row is expanded. */
export const registryMembers: MemberLister = obj => {
  const def = (CONTROL_TYPES as Record<string, ControlTypeDef | undefined>)[obj.vbTypeName];
  return def ? def.props.filter(p => p.runtime !== 'none').map(p => p.name) : [];
};

async function assignValue(d: DebugDeps, node: DebugNode, text: string): Promise<void> {
  const t = d.target();
  if (!t || !d.inBreak()) return;
  const r = await t.immediate(`${node.expr} = ${text}`);
  if (r) await messageBox98(d.doc, { prompt: r, title: 'VibeBasic', buttons: 16 });
  d.changed();
}

const contextText = (d: DebugDeps, at: StackEntry | null): string =>
  (at ? [d.projectName(), at.moduleName, at.procName].filter(Boolean).join('.') : '<Ready>');

export interface LocalsWindow { el: HTMLElement; refresh(): void }

/** The Locals window: the stopped procedure (with a "..." button for the Call Stack) and its variables. */
export function createLocalsWindow(host: HTMLElement, d: DebugDeps, callStack: () => void): LocalsWindow {
  const label = h('div', { class: 'dbg98-context' }, '<Ready>');
  const more = h('button', { type: 'button', class: 'dbg98-more', title: 'Call Stack' }, '...');
  more.addEventListener('click', () => { if (d.inBreak()) callStack(); });
  const tree = new TreeList(['Expression', 'Value', 'Type'], { onEdit: (n, text) => { void assignValue(d, n, text); } });
  const el = h('div', { class: 'dbg98' }, h('div', { class: 'dbg98-bar' }, label, more), tree.el);
  host.appendChild(el);
  return {
    el,
    refresh() {
      const t = d.inBreak() ? d.target() : null;
      label.textContent = contextText(d, t?.debug.context() ?? null);
      tree.set(t ? t.debug.locals(d.members).map(node => ({ node, key: node.expr })) : []);
    },
  };
}

export interface WatchWindow { el: HTMLElement; refresh(): Promise<void>; selected(): number | null }

export function watchContext(w: WatchDef): string {
  if (!w.module) return '(All Modules)';
  return w.procedure ? `${w.module}.${w.procedure}` : w.module;
}

/** The Watches window: Expression | Value | Type | Context of each watch. */
export function createWatchWindow(host: HTMLElement, d: DebugDeps & {
  watches(): WatchDef[]; add(): void; edit(i: number): void; remove(i: number): void;
}): WatchWindow {
  const tree = new TreeList(['Expression', 'Value', 'Type', 'Context'], {
    onEdit: (n, text) => { void assignValue(d, n, text); },
    onKey: (e, row) => { if (row && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); d.remove(row.root.tag!); } },
    onNameDblClick: row => { if (row.depth === 0) d.edit(row.root.tag!); },
    onContext: (e, row) => popupMenu(d.doc, e.clientX, e.clientY, [
      ...(row ? [{ label: 'Edit Watch...', action: () => d.edit(row.root.tag!) }] : []),
      { label: 'Add Watch...', action: () => d.add() },
      ...(row ? [{ label: 'Delete Watch', action: () => d.remove(row.root.tag!) }] : []),
    ]),
  });
  const el = h('div', { class: 'dbg98' }, tree.el);
  host.appendChild(el);
  let gen = 0;
  return {
    el,
    async refresh() {
      const my = ++gen;
      const t = d.inBreak() ? d.target() : null;
      const roots: Root[] = [];
      for (const [i, w] of d.watches().entries()) {
        const node: DebugNode = t ? await t.debug.watchNode(w, d.members)
          : { name: w.expression, expr: w.expression, value: OUT_OF_CONTEXT, type: 'Empty', editable: false };
        roots.push({ node, key: `w${i}:${w.expression}`, extra: watchContext(w), tag: i });
      }
      if (my === gen) tree.set(roots);
    },
    selected: () => tree.selectedRow()?.root.tag ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Dialogs

let radioIds = 0;
const radio = (name: string, label: string, on: boolean): { el: HTMLElement; input: HTMLInputElement } => {
  const id = `dbg98-radio-${++radioIds}`;
  const input = h('input', { type: 'radio', name, id, checked: on }) as HTMLInputElement;
  return { input, el: h('div', { class: 'dlgform98-check' }, input, h('label', { for: id }, label)) };
};
const ALL_PROCS = '(All Procedures)', ALL_MODULES = '(All Modules)';

/**
 * Add Watch / Edit Watch: Expression, Context (Procedure and Module) and Watch Type. Resolves with the watch, 'delete'
 * (Edit Watch's Delete button) or null (Cancel, or no expression).
 */
export async function showWatchDialog(doc: Document, o: {
  title: 'Add Watch' | 'Edit Watch'; init: WatchDef; projectName: string; modules: string[]; procsOf(module: string): string[];
}): Promise<WatchDef | 'delete' | null> {
  const expr = h('input', { type: 'text', value: o.init.expression, 'data-autofocus': '' }) as HTMLInputElement;
  const mod = h('select', { class: 'dlgform98-select' }, ...[ALL_MODULES, ...o.modules].map(m => h('option', { value: m }, m))) as HTMLSelectElement;
  const proc = h('select', { class: 'dlgform98-select' }) as HTMLSelectElement;
  const fillProcs = (selected: string | null) => {
    const names = mod.value === ALL_MODULES ? [] : o.procsOf(mod.value);
    proc.replaceChildren(...[ALL_PROCS, ...names].map(p => h('option', { value: p }, p)));
    proc.value = selected && names.some(n => n.toLowerCase() === selected.toLowerCase()) ? names.find(n => n.toLowerCase() === selected.toLowerCase())! : ALL_PROCS;
    proc.disabled = mod.value === ALL_MODULES;
  };
  mod.value = o.init.module && o.modules.find(m => m.toLowerCase() === o.init.module!.toLowerCase()) || ALL_MODULES;
  fillProcs(o.init.procedure);
  mod.addEventListener('change', () => fillProcs(null));
  const kinds = [
    { kind: 'watch' as const, r: radio('dbg98-kind', 'Watch Expression', o.init.kind === 'watch') },
    { kind: 'breakTrue' as const, r: radio('dbg98-kind', 'Break When Value Is True', o.init.kind === 'breakTrue') },
    { kind: 'breakChange' as const, r: radio('dbg98-kind', 'Break When Value Changes', o.init.kind === 'breakChange') },
  ];
  const content = h('div', { class: 'dlgform98 dbg98-dlg' },
    h('div', { class: 'dlgform98-row' }, h('span', {}, 'Expression:'), expr),
    h('fieldset', {}, h('legend', {}, 'Context'),
      h('div', { class: 'dlgform98-row' }, h('span', {}, 'Procedure:'), proc),
      h('div', { class: 'dlgform98-row' }, h('span', {}, 'Module:'), mod),
      h('div', { class: 'dlgform98-row' }, h('span', {}, 'Project:'), h('div', {}, o.projectName))),
    h('fieldset', {}, h('legend', {}, 'Watch Type'), ...kinds.map(k => k.r.el)));
  const buttons = [
    { label: 'OK', value: 'ok', default: true },
    { label: 'Cancel', value: 'cancel', cancel: true },
    ...(o.title === 'Edit Watch' ? [{ label: 'Delete', value: 'delete' }] : []),
  ];
  const r = await showDialog98(doc, { title: o.title, content, buttons });
  if (r === 'delete') return 'delete';
  if (r !== 'ok' || !expr.value.trim()) return null;
  return {
    expression: expr.value.trim(),
    module: mod.value === ALL_MODULES ? null : mod.value,
    procedure: mod.value === ALL_MODULES || proc.value === ALL_PROCS ? null : proc.value,
    kind: kinds.find(k => k.r.input.checked)?.kind ?? 'watch',
  };
}

/** Quick Watch (Shift+F9): the context, the expression and its value; true when Add was pressed. */
export async function showQuickWatch(doc: Document, o: { context: string; expression: string; value: string }): Promise<boolean> {
  const box = (legend: string, text: string) => h('fieldset', {}, h('legend', {}, legend), h('div', { class: 'dbg98-qw' }, text));
  const content = h('div', { class: 'dlgform98 dbg98-dlg' }, box('Context', o.context), box('Expression', o.expression), box('Value', o.value));
  return await showDialog98(doc, { title: 'Quick Watch', content, buttons: [
    { label: 'Add', value: 'add', default: true }, { label: 'Cancel', value: 'cancel', cancel: true },
  ] }) === 'add';
}

/** Call Stack (Ctrl+L): the active procedure calls, newest first; resolves with the index to Show, or null. */
export async function showCallStack(doc: Document, entries: string[]): Promise<number | null> {
  let sel = entries.length ? 0 : -1;
  const rows = entries.map((e, i) => h('div', { class: i === 0 ? 'dbg98-stackrow selected' : 'dbg98-stackrow' }, e));
  const list = h('div', { class: 'dbg98-stack', tabindex: '0', 'data-autofocus': '' }, ...rows);
  const pick = (i: number) => { sel = i; rows.forEach((r, k) => r.classList.toggle('selected', k === i)); };
  rows.forEach((r, i) => {
    r.addEventListener('mousedown', () => pick(i));
    r.addEventListener('dblclick', () => list.closest('.dlg98')?.querySelector<HTMLButtonElement>('button.default')?.click());
  });
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (rows.length) pick(Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))));
  });
  const content = h('div', { class: 'dlgform98 dbg98-dlg' }, h('div', {}, 'Project.Module.Function'), list);
  const r = await showDialog98(doc, { title: 'Call Stack', content, buttons: [
    { label: 'Show', value: 'show', default: true, disabled: !entries.length }, { label: 'Close', value: 'close', cancel: true },
  ] });
  return r === 'show' && sel >= 0 ? sel : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring

/** What the run controller offers the debug windows (RunController). */
export interface DebugRun {
  readonly session: { program: { debug: ProgramDebugger }; immediate(text: string): Promise<string> } | null;
  setNextStatement(moduleName: string, line: number): string | null;
  showNextStatement(): void;
  showStackFrame(e: StackEntry, newest: boolean): void;
}

/** The active code window as the debug commands use it. */
export interface CodeTarget { moduleName: string; line: number; selection: string | null; exprAtCursor: string | null }

export interface DebugEnv {
  localsHost: HTMLElement;
  watchHost: HTMLElement;
  showPane(name: 'locals' | 'watch'): void;
  run: DebugRun;
  /** The active code window, or null. */
  code(): CodeTarget | null;
  doc: Document;
}

/** Registers the debug actions (View > Locals / Watch / Call Stack, Debug > watches, Set / Show Next Statement). */
export function registerDebugActions(ide: IdeState, actions: IdeActions, env: DebugEnv): { dataTip(moduleName: string, expr: string): string | null } {
  const doc = env.doc;
  const target = (): DebugTarget | null => {
    const s = env.run.session;
    return s ? { debug: s.program.debug, immediate: t => s.immediate(t) } : null;
  };
  const deps: DebugDeps = {
    target, inBreak: () => ide.mode === 'break', projectName: () => ide.project.name, members: registryMembers, doc,
    changed: () => refresh(),
  };
  const watches = (): WatchDef[] => ide.project.watches ?? [];
  const setWatches = (list: WatchDef[]): void => {
    if (list.length) ide.project.watches = list;
    else delete ide.project.watches;
    ide.stack.markDirtyExternal();
    void env.run.session?.program.debug.setWatches(list);
    void watchWin.refresh();
  };
  const items = () => [...ide.project.forms, ...ide.project.modules];
  const dialogOpts = (title: 'Add Watch' | 'Edit Watch', init: WatchDef) => ({
    title, init, projectName: ide.project.name, modules: items().map(x => x.name),
    procsOf: (m: string) => listProcedures(items().find(x => x.name.toLowerCase() === m.toLowerCase())?.code ?? '').map(p => p.name),
  });
  /** The procedure around the cursor of the active code window (the default watch context). */
  const codeContext = (): { module: string | null; procedure: string | null; expr: string } => {
    const c = env.code();
    if (!c) return { module: null, procedure: null, expr: '' };
    const code = items().find(x => x.name.toLowerCase() === c.moduleName.toLowerCase())?.code ?? '';
    const p = listProcedures(code).find(x => c.line >= x.line && c.line <= x.endLine);
    return { module: c.moduleName, procedure: p?.name ?? null, expr: c.selection?.trim() || c.exprAtCursor || '' };
  };
  const addWatch = async (init?: Partial<WatchDef>): Promise<void> => {
    const c = codeContext();
    const w = await showWatchDialog(doc, dialogOpts('Add Watch', { expression: c.expr, module: c.module, procedure: c.procedure, kind: 'watch', ...init }));
    if (w && w !== 'delete') { setWatches([...watches(), w]); env.showPane('watch'); }
  };
  const editWatch = async (i: number): Promise<void> => {
    const old = watches()[i];
    if (!old) return;
    const w = await showWatchDialog(doc, dialogOpts('Edit Watch', old));
    if (w === 'delete') setWatches(watches().filter((_, k) => k !== i));
    else if (w) setWatches(watches().map((x, k) => (k === i ? w : x)));
  };
  const removeWatch = (i: number): void => setWatches(watches().filter((_, k) => k !== i));
  const showStack = async (): Promise<void> => {
    const dbg = ide.mode === 'break' ? env.run.session?.program.debug : undefined;
    if (!dbg) return;
    const stack = dbg.callStack();
    const i = await showCallStack(doc, stack.map(e => `${ide.project.name}.${e.moduleName}.${e.procName}`));
    if (i !== null && stack[i]) env.run.showStackFrame(stack[i], i === 0);
  };

  const locals = createLocalsWindow(env.localsHost, deps, () => { void showStack(); });
  const watchWin = createWatchWindow(env.watchHost, { ...deps, watches, add: () => { void addWatch(); }, edit: i => { void editWatch(i); }, remove: removeWatch });
  const refresh = (): void => { locals.refresh(); void watchWin.refresh(); };
  // values change on each break and step (the run in between keeps the last ones, as VB6 does); design mode clears them
  ide.on('mode', () => { if (ide.mode !== 'run') refresh(); });
  let shownWatches: WatchDef[] | undefined;
  ide.on('project', () => { if (ide.project.watches !== shownWatches) { shownWatches = ide.project.watches; void watchWin.refresh(); } });
  refresh();

  actions.viewLocals = () => { env.showPane('locals'); locals.refresh(); };
  actions.viewWatch = () => { env.showPane('watch'); void watchWin.refresh(); };
  actions.viewCallStack = () => { void showStack(); };
  actions.addWatch = () => { void addWatch(); };
  actions.editWatch = () => { void editWatch(watchWin.selected() ?? 0); };
  actions.quickWatch = async () => {
    const dbg = ide.mode === 'break' ? env.run.session?.program.debug : undefined;
    const c = codeContext();
    if (!dbg) return;
    if (!c.expr) { await messageBox98(doc, { prompt: 'No watch expression', title: 'VibeBasic', buttons: 48 }); return; }
    const r = await dbg.evaluate(c.expr);
    const value = !r.ok ? r.error : isObject(r.value) || r.value instanceof VBArray || r.value instanceof VBRecord ? vbTypeName(r.value) : valueText(r.value);
    const at = dbg.context();
    if (await showQuickWatch(doc, { context: contextText(deps, at), expression: c.expr, value })) {
      setWatches([...watches(), { expression: c.expr, module: at?.moduleName ?? c.module, procedure: at?.procName || null, kind: 'watch' }]);
      env.showPane('watch');
    }
  };
  actions.setNextStatement = async () => {
    const c = env.code();
    if (!c || ide.mode !== 'break') return;
    const err = env.run.setNextStatement(c.moduleName, c.line);
    if (err) await messageBox98(doc, { prompt: err, title: 'VibeBasic', buttons: 48 });
  };
  actions.showNextStatement = () => env.run.showNextStatement();

  return {
    dataTip(moduleName, expr) {
      const dbg = ide.mode === 'break' ? env.run.session?.program.debug : undefined;
      const at = dbg?.context();
      // only in the code of the stopped procedure's module (another module's names would be looked up in the wrong place)
      if (!dbg || !at || at.moduleName.toLowerCase() !== moduleName.toLowerCase()) return null;
      return dbg.dataTip(expr);
    },
  };
}
