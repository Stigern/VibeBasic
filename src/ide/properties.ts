// Properties window (VB6): object box on top, Alphabetic / Categorized property lists, description pane at the
// bottom. Every edit goes through IdeState.stack as one undo step. Dropdowns and editor popups are rendered in
// the body-level popup layer (ui98/floating.ts), so the window's scrolling panes never clip them.
import { getBackend, type Backend } from '../backend/backend';
import { assetOf, assetUsedElsewhere } from '../model/assetRefs';
import { addAssetCmd, compositeCmd, removeAssetCmd, renameCmd, renameModuleCmd, setInstancingCmd, setPropertyCmd, tabIndexCmd, type Command } from '../model/commands';
import { CONTROL_TYPES, getPropDef, newId, validateName, type PropDef } from '../model/controls';
import { formHasProp, formObjectName } from '../model/mdi';
import type { ControlDef, ControlType, FontValue, FormDef, ModuleDef, PropValue } from '../model/types';
import { messageBox98, vbYes } from '../ui98/dialogs';
import { createCombo } from '../ui98/combo';
import { h } from '../ui98/dom';
import { showFloating } from '../ui98/floating';
import { createTabs } from '../ui98/tabs';
import type { IdeState } from './ideState';
import { customPropEditor, imageListRenameCmds } from './imageListEditor';
import { dataSourceRenameCmds } from './dataSourceEditor';
import { bytesToBase64, createColorPopup, formatPropertyValue, mimeFromPath, parsePropertyInput, showFontDialog } from './propertyEditors';
import { CATEGORIES, categoryOf, describeProperty, type Category } from './propertyInfo';

const VB_OK_EXCL = 48, VB_YESNO_QUESTION = 4 | 32;
const NAME_DEF: PropDef = { name: '(Name)', kind: 'string', default: '', designTime: true, runtime: 'rw' };
// Index is listed for every single control (VB6): blank = not in a control array, a number makes or joins one
/** A class module's Instancing property and its VB6 values (stored only: every class is private to the project). */
const INSTANCING = 'Instancing';
const INSTANCING_VALUES = [
  { value: 1, label: '1 - Private' }, { value: 2, label: '2 - PublicNotCreatable' },
  { value: 5, label: '5 - MultiUse' }, { value: 6, label: '6 - GlobalMultiUse' },
];
const USER_SCALE = new Set(['ScaleLeft', 'ScaleTop', 'ScaleWidth', 'ScaleHeight']);
const INDEX_DEF: PropDef = { name: 'Index', kind: 'int', default: null, designTime: true, runtime: 'rw', min: 0, max: 32767 };
const DEFAULT_FONT: FontValue = { name: 'MS Sans Serif', size: 8, bold: false, italic: false, underline: false };

// The chosen tab (Alphabetic / Categorized) is remembered for the session and, when storage works, across runs.
const TAB_KEY = 'vibebasic.properties.tab';
let rememberedTab = (() => { try { return localStorage.getItem(TAB_KEY) === '1' ? 1 : 0; } catch { return 0; } })();

interface Target { id: string | 'form'; type: ControlType; name: string; index: number | null; props: Record<string, PropValue> }

export interface PropertiesWindow {
  refresh(): void;
  focus(): void;
  /** Commits a value typed in the active row but not yet entered (VB6 does so before Run, Save and Make). False when the text is
   *  invalid (a message box says so, and the caller should not go on). */
  commitPendingEdit(): boolean;
}

/** "Form1 Form" → <b>Form1</b> Form, as in VB6's object box. */
function formatObject(label: string): Node {
  const i = label.lastIndexOf(' ');
  const f = document.createDocumentFragment();
  if (i < 0) { f.append(h('b', {}, label)); return f; }
  f.append(h('b', {}, label.slice(0, i)), label.slice(i));
  return f;
}

export function createPropertiesWindow(host: HTMLElement, ide: IdeState, opts: { backend?: Backend } = {}): PropertiesWindow {
  const doc = host.ownerDocument;
  let active: string | null = null;      // the selected property row
  let wantFocus = false;                 // move the keyboard focus to the active row after the next render
  let epoch = 0;                         // bumped on every render; editors of older renders are dead
  let flushEdit: (() => boolean) | null = null;   // commits the active inline editor; false when the text is invalid
  let openActive: (() => void) | null = null;     // opens the active row's dialog/popup (Enter, double-click, typing)
  let closers: (() => void)[] = [];               // closes the open lists/popups of the current render
  let rowOrder: string[] = [];
  const collapsed = new Set<Category>();
  let objectEntries: { label: string; id: string | 'form' }[] = [];

  const objectCombo = createCombo({
    items: [], format: formatObject,
    onChange: v => {
      const form = currentForm(), e = objectEntries.find(x => x.label === v);
      if (form && e) ide.setSelection({ formId: form.id, ids: e.id === 'form' ? [] : [e.id] });
    },
  });
  const lists = [h('div', { class: 'pw98-list' }), h('div', { class: 'pw98-list pw98-categorized' })];
  const tabs = createTabs([{ label: 'Alphabetic', content: lists[0] }, { label: 'Categorized', content: lists[1] }], {
    selected: rememberedTab,
    onSelect: i => { rememberedTab = i; try { localStorage.setItem(TAB_KEY, String(i)); } catch { /* storage unavailable */ } refresh(); },
  });
  const desc = h('div', { class: 'pw98-desc' });
  const root = h('div', { class: 'pw98' }, objectCombo.el, tabs.el, desc);
  host.replaceChildren(root);

  // A standard module is shown (a single (Name) row, VB6) after it was picked in the Project Explorer or its code window was
  // activated, until a form or control is selected or another window is activated.
  let moduleId: string | null = null;
  const currentModule = (): ModuleDef | undefined => (moduleId ? ide.project.modules.find(m => m.id === moduleId) : undefined);
  const currentForm = (): FormDef | undefined => {
    const fid = ide.selection?.formId ?? (ide.activeView.kind === 'designer' ? ide.activeView.formId : undefined);
    return ide.project.forms.find(f => f.id === fid);
  };
  const targets = (form: FormDef): Target[] => {
    const ids = (ide.selection?.formId === form.id ? ide.selection.ids : []).filter(i => form.controls.some(c => c.id === i));
    if (!ids.length) return [{ id: 'form', type: 'Form', name: form.name, index: null, props: form.props }];
    return ids.map(i => form.controls.find(c => c.id === i)!).map(c => ({ id: c.id, type: c.type, name: c.name, index: c.index, props: c.props }));
  };
  const labelOf = (name: string, index: number | null, type: string) => `${name}${index !== null ? `(${index})` : ''} ${type}`;

  const invalid = async () => {
    await messageBox98(doc, { prompt: 'Invalid property value', title: 'VibeBasic', buttons: VB_OK_EXCL });
    wantFocus = true;
    refresh();
  };

  function setValue(form: FormDef, ts: Target[], def: PropDef, value: PropValue, extra: Command[] = []): void {
    const cmds = ts.map(t => setPropertyCmd(form.id, t.id, def.name, value));
    ide.stack.execute(extra.length || cmds.length > 1 ? compositeCmd(`Change ${def.name}`, [...extra, ...cmds]) : cmds[0]);
  }

  async function setName(form: FormDef, t: Target, text: string): Promise<void> {
    const name = text.trim();
    if (!validateName(name)) return invalid();
    if (t.id === 'form') {
      if (name === form.name) { refresh(); return; }
      const clash = ide.project.forms.some(f => f.id !== form.id && f.name.toLowerCase() === name.toLowerCase())
        || ide.project.modules.some(m => m.name.toLowerCase() === name.toLowerCase());
      if (clash) return invalid();
      ide.stack.execute(renameCmd(form.id, 'form', name, null));
      return;
    }
    if (name === t.name) { refresh(); return; }
    const others = form.controls.filter(c => c.id !== t.id && c.name.toLowerCase() === name.toLowerCase());
    if (!others.length) {
      // a member of an array that gets a new unique name leaves the array
      const rename = renameCmd(form.id, t.id, name, t.name.toLowerCase() === name.toLowerCase() ? t.index : null);
      // an ImageList takes the references of the Toolbars, TreeViews, ... that use it along (one undo step)
      const follow = t.type === 'ImageList' ? imageListRenameCmds(form, t.name, name)
        : t.type === 'Data' || t.type === 'Adodc' ? dataSourceRenameCmds(form, t.name, name) : [];
      ide.stack.execute(follow.length ? compositeCmd('Rename', [rename, ...follow]) : rename);
      return;
    }
    if (others[0].type !== t.type) return invalid();
    // Joining an existing control array is silent (as in Task 7's paste and VB6); only a new array asks.
    const cmds: Command[] = [];
    if (others.every(o => o.index === null)) {
      const r = await messageBox98(doc, {
        prompt: `You already have a control named '${others[0].name}'. Do you want to create a control array?`,
        title: 'VibeBasic', buttons: VB_YESNO_QUESTION,
      });
      if (r !== vbYes) { refresh(); return; }
      cmds.push(renameCmd(form.id, others[0].id, others[0].name, 0));
    }
    const used = new Set(others.every(o => o.index === null) ? [0] : others.map(o => o.index));
    let idx = 0;
    while (used.has(idx)) idx++;
    cmds.push(renameCmd(form.id, t.id, others[0].name, idx));
    ide.stack.execute(compositeCmd('Rename', cmds));
  }

  async function setModuleName(m: ModuleDef, text: string): Promise<void> {
    const name = text.trim();
    if (!validateName(name)) return invalid();
    if (name === m.name) { refresh(); return; }
    const clash = ide.project.modules.some(x => x.id !== m.id && x.name.toLowerCase() === name.toLowerCase())
      || ide.project.forms.some(f => f.name.toLowerCase() === name.toLowerCase());
    if (clash) return invalid();
    ide.stack.execute(renameModuleCmd(m.id, name));
  }

  async function setIndex(form: FormDef, t: Target, v: number | null): Promise<void> {
    const same = form.controls.filter(c => c.id !== t.id && c.name.toLowerCase() === t.name.toLowerCase());
    // blank leaves the array only for its last member; a number must be free in the array
    if (v === null ? same.length > 0 : same.some(c => c.index === v)) return invalid();
    if (v !== t.index) ide.stack.execute(renameCmd(form.id, t.id, t.name, v)); else refresh();
  }

  async function applyValue(form: FormDef, ts: Target[], def: PropDef, value: PropValue): Promise<void> {
    if (def === NAME_DEF) return typeof value === 'string' ? setName(form, ts[0], value) : undefined;
    if (def === INDEX_DEF) return setIndex(form, ts[0], value as number | null);
    if (ts.every(t => JSON.stringify(t.props[def.name] ?? def.default) === JSON.stringify(value))) { refresh(); return; }
    if (def.name === 'TabIndex' && typeof value === 'number' && ts.every(t => t.id !== 'form')) {
      // VB6: the others shift so that TabIndex stays unique and without gaps; a value past the last is the last
      const last = form.controls.filter(c => typeof c.props.TabIndex === 'number').length - 1;
      if (ts.length === 1 && Math.min(value, last) === ts[0].props.TabIndex) { refresh(); return; }
      const cmds = ts.map(t => tabIndexCmd(form.id, { id: t.id, index: value }));
      ide.stack.execute(cmds.length > 1 ? compositeCmd('Change TabIndex', cmds) : cmds[0]);
      return;
    }
    setValue(form, ts, def, value);
  }

  /** Removes the pictures `def` of `ts` names that nothing else names, for when they are replaced or cleared (one undo step). */
  function dropPictures(ts: Target[], def: PropDef): Command[] {
    const own = new Map<string, number>();
    for (const t of ts) { const a = assetOf(t.props[def.name]); if (a) own.set(a, (own.get(a) ?? 0) + 1); }
    const p = ide.project;
    return [...own].filter(([a, n]) => a in p.assets && a !== p.iconAsset && !assetUsedElsewhere(p, a, n)).map(([a]) => removeAssetCmd(a));
  }

  async function applyText(form: FormDef, ts: Target[], def: PropDef, text: string): Promise<void> {
    if (def === INDEX_DEF && text.trim() === '') return setIndex(form, ts[0], null);
    const r = parsePropertyInput(def, text);
    if (!r.ok) return invalid();
    return applyValue(form, ts, def, r.value);
  }

  async function pickPicture(form: FormDef, ts: Target[], def: PropDef): Promise<void> {
    const backend = opts.backend ?? getBackend();
    const path = await backend.openFileDialog([{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }]);
    if (!path) return;
    const bytes = await backend.readBinaryFile(path);
    const id = `asset-${newId()}`;
    setValue(form, ts, def, { asset: id }, [addAssetCmd(id, { mime: mimeFromPath(path), dataBase64: bytesToBase64(bytes) }), ...dropPictures(ts, def)]);
  }

  /** Values a bool/enum row cycles through (double-click) and lists in its dropdown. */
  const choices = (def: PropDef): { value: PropValue; label: string }[] =>
    def.kind === 'bool' ? [{ value: true, label: 'True' }, { value: false, label: 'False' }] : (def.enumValues ?? []);

  /** Single-line text box: Enter commits, Escape restores the old value, leaving the row commits. */
  function inlineEditor(def: PropDef, initial: string, live: () => boolean, commitText: (t: string) => void): HTMLInputElement {
    const el = h('input', { type: 'text', class: 'pw98-editor', value: initial });
    const shown = el.value;   // as the input sanitised it (no line breaks): an untouched row never commits
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); wantFocus = true; commitText(el.value); }
      else if (e.key === 'Escape') { e.preventDefault(); el.value = initial; el.select(); }
    });
    el.addEventListener('blur', () => { if (el.value !== shown) commitText(el.value); });
    flushEdit = () => {
      if (!live() || el.value === shown) return true;
      const ok = (def === INDEX_DEF && el.value.trim() === '') || parsePropertyInput(def, el.value).ok;
      commitText(el.value);
      return ok;
    };
    return el;
  }

  /** Builds the editor of the active row in `cell`. */
  function editorFor(form: FormDef, ts: Target[], def: PropDef, cell: HTMLElement, value: PropValue | undefined): HTMLElement | null {
    const myEpoch = epoch;
    const mixed = value === undefined && ts.length > 1;   // differing values in a multi-selection: blank
    const shown = mixed ? '' : formatPropertyValue(def, value);
    let done = false;
    const live = () => !done && myEpoch === epoch && ide.mode === 'design';
    // ImageList family (imageListEditor.ts): its own dropdown / "(Custom)..." dialog, wired like the standard editors.
    // A dialog's result arrives after the await, so it only needs design mode, not the same render.
    const custom = customPropEditor({
      doc, backend: opts.backend ?? getBackend(), project: ide.project, form, type: ts[0].type, def, value, cell,
      apply: (v, extra) => {
        if (ide.mode !== 'design') return;
        wantFocus = true;
        if (extra?.length) setValue(form, ts, def, v, extra); else void applyValue(form, ts, def, v);
      },
    });
    if (custom) {
      closers.push(() => custom.close());
      openActive = () => { if (live()) custom.open(); };
      return custom.focus;
    }
    const commitText = (t: string) => { if (!live()) return; done = true; void applyText(form, ts, def, t); };
    const commitValue = (v: PropValue) => { if (!live()) return; done = true; void applyValue(form, ts, def, v); };

    const inline = (initial: string): HTMLInputElement => inlineEditor(def, initial, live, commitText);
    const button = (label: string, title: string, onclick: () => void) => {
      const b = h('button', { type: 'button', class: 'pw98-btn', title }, label);
      b.addEventListener('mousedown', e => e.preventDefault());   // the row keeps the focus
      b.addEventListener('click', () => { if (live()) onclick(); });
      return b;
    };
    const valText = () => h('span', { class: 'pw98-valtext' }, shown);

    // multi-line editor under the cell (List, Panels, multi-line Text): Enter = new line, Ctrl+Enter or clicking away commits
    const openMultiline = () => {
      if (!live()) return;
      const initial = mixed ? '' : def.kind === 'list' ? (Array.isArray(value) ? value.join('\n') : '') : String(value ?? '');
      const ta = h('textarea', { class: 'pw98-multiedit', rows: '8', spellcheck: false });
      ta.value = initial;
      let discard = false;
      // A re-render (a click in the designer selects on pointerdown, before the popup sees the outside mousedown), Save, Run
      // and Make commit the text through flushEdit, as they do for an inline row. Only Escape throws it away.
      const flush = () => {
        if (flushEdit === flush) flushEdit = null;
        if (!live() || ta.value === initial) return true;
        const ok = parsePropertyInput(def, ta.value).ok;
        commitText(ta.value);
        return ok;
      };
      flushEdit = flush;
      const fl = showFloating(cell, h('div', { class: 'pw98-popup' }, ta), {
        align: 'right', minWidth: 170,
        onClose: reason => {
          if (discard) return;
          if (flushEdit === flush) flushEdit = null;
          if (reason === 'escape') { wantFocus = true; refresh(); return; }
          if (reason !== 'outside') wantFocus = true;
          if (ta.value !== initial) commitText(ta.value); else if (wantFocus) refresh();
        },
      });
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fl.close('api'); }
      });
      closers.push(() => { discard = true; fl.close(); });   // refresh() has already run flushEdit
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };

    switch (def.kind) {
      case 'bool': case 'enum': {
        const combo = createCombo({ items: choices(def).map(c => c.label), value: shown, openOnClick: false, onChange: v => { wantFocus = true; commitText(v); } });
        closers.push(() => combo.close());
        openActive = () => combo.open();
        cell.replaceChildren(combo.el);
        return combo.el.querySelector('input');
      }
      case 'text': case 'list': {
        // a value with line breaks (MultiLine set to False afterwards keeps them, VB6) gets the multi-line editor too
        const multi = def.kind === 'list' || ts.every(t => t.props.MultiLine === true) || (typeof value === 'string' && value.includes('\n'));
        if (!multi) { const el = inline(mixed ? '' : String(value ?? '')); cell.replaceChildren(el); return el; }
        openActive = openMultiline;
        cell.replaceChildren(valText(), button('', 'Edit', openMultiline));
        cell.lastElementChild!.append(h('span', { class: 'cb98-glyph' }));
        return null;
      }
      case 'color': {
        const input = inline(shown);
        const openColors = () => {
          let discard = false;
          const popup = createColorPopup(n => { discard = true; fl.close(); wantFocus = true; commitValue(n); }, () => fl.close());
          const fl = showFloating(cell, popup, { align: 'right', onClose: () => { if (!discard) input.focus(); } });
          closers.push(() => { discard = true; fl.close(); });
        };
        openActive = openColors;
        const btn = button('', 'Pick colour', openColors);
        btn.append(h('span', { class: 'cb98-glyph' }));
        cell.replaceChildren(input, btn);
        return input;
      }
      case 'font': case 'picture': {
        const open = async () => {
          if (def.kind === 'picture') return pickPicture(form, ts, def);
          const cur = ts[0].props[def.name];
          const f = await showFontDialog(doc, cur && typeof cur === 'object' && 'name' in cur ? cur : DEFAULT_FONT);
          wantFocus = true;
          if (f) commitValue(f); else refresh();
        };
        openActive = () => void open();
        cell.replaceChildren(valText(), button('...', def.kind === 'font' ? 'Font' : 'Picture', () => void open()));
        return null;
      }
      case 'date':   // typed as CDate reads it (parsePropertyInput); blank = no date
      default: {
        const el = inline(shown);
        cell.replaceChildren(el);
        return el;
      }
    }
  }

  // ---- render --------------------------------------------------------------------------------------------------
  function refresh(): void {
    // a value still being typed is committed first (selection, project or view changes); Escape has already restored the old text
    const pending = flushEdit;
    flushEdit = null;
    pending?.();
    const hadFocus = wantFocus || root.contains(doc.activeElement);
    wantFocus = false;
    epoch++;
    openActive = null;
    for (const c of closers.splice(0)) c();
    const mod = currentModule();
    if (mod) { renderModule(mod, hadFocus); return; }
    const form = currentForm();
    root.classList.toggle('pw98-empty', !form);
    if (!form) { for (const l of lists) l.replaceChildren(); desc.replaceChildren(); objectCombo.setItems([]); objectCombo.setValue(''); rowOrder = []; return; }
    const ts = targets(form);
    const multi = ts.length > 1;

    // Object box: the form and all its controls
    objectEntries = [{ label: labelOf(form.name, null, formObjectName(form)), id: 'form' },
      ...form.controls.map((c: ControlDef) => ({ label: labelOf(c.name, c.index, c.type), id: c.id }))];
    const first = ts[0];
    objectCombo.setItems(objectEntries.map(e => e.label));
    objectCombo.setValue(multi ? '' : labelOf(first.name, first.index, first.id === 'form' ? formObjectName(form) : first.type));

    // Rows: properties common to all selected types
    const defs = CONTROL_TYPES[first.type].props.filter(d => d.designTime && (first.id !== 'form' || formHasProp(form, d.name))).filter(d => ts.every(t => {
      const o = getPropDef(t.type, d.name);
      return o && o.designTime && o.kind === d.kind && (d.kind !== 'enum' || JSON.stringify(o.enumValues) === JSON.stringify(d.enumValues))
        && (!USER_SCALE.has(d.name) || t.props.ScaleMode === 0);   // ScaleLeft ... ScaleHeight only for the user scale (ScaleMode 0)
    }));
    const rows: PropDef[] = [...(multi ? [] : [NAME_DEF]), ...defs];
    if (!multi && first.id !== 'form') rows.push(INDEX_DEF);
    const byName = (a: PropDef, b: PropDef) => (a === NAME_DEF ? -1 : b === NAME_DEF ? 1 : a.name.localeCompare(b.name));
    rows.sort(byName);
    if (active && !rows.some(r => r.name === active)) active = null;

    const valueOf = (d: PropDef): PropValue | undefined => {
      const get = (t: Target) => d === NAME_DEF ? t.name : d === INDEX_DEF ? t.index : t.props[d.name] ?? d.default;
      const v0 = get(first);
      return ts.every(t => JSON.stringify(get(t)) === JSON.stringify(v0)) ? v0 : undefined;
    };

    let focusEl: HTMLElement | null = null;
    const rowEl = (d: PropDef): HTMLElement => {
      const v = valueOf(d);
      const cell = h('div', { class: 'pw98-value' });
      const isActive = active === d.name;
      const row = h('div', { class: `pw98-row${isActive ? ' selected' : ''}`, 'data-prop': d.name, tabindex: '-1' },
        h('div', { class: 'pw98-name' }, d.name), cell);
      if (isActive) focusEl = editorFor(form, ts, d, cell, v) ?? row;
      else cell.textContent = v === undefined && multi ? '' : formatPropertyValue(d, v);
      const activate = (e: Event) => {
        if (ide.mode !== 'design' || active === d.name) return;
        if (e.type === 'mousedown') e.preventDefault();   // the row is re-rendered: focus goes to its new editor
        select(d.name);
      };
      row.addEventListener('mousedown', activate);
      row.addEventListener('click', activate);
      row.addEventListener('dblclick', () => { if (ide.mode === 'design') cycleOrOpen(form, ts, d, v); });
      return row;
    };

    const list = lists[tabs.selected];
    lists[1 - tabs.selected].replaceChildren();
    const els: HTMLElement[] = [];
    rowOrder = [];
    if (tabs.selected === 0) {
      for (const d of rows) { els.push(rowEl(d)); rowOrder.push(d.name); }
    } else {
      for (const cat of CATEGORIES) {
        const inCat = rows.filter(d => categoryOf(d.name) === cat);
        if (!inCat.length) continue;
        const shut = collapsed.has(cat);
        const head = h('div', { class: 'pw98-cat', 'data-cat': cat }, h('span', { class: 'pw98-cat-box' }, shut ? '+' : '-'), cat);
        head.addEventListener('click', () => { if (shut) collapsed.delete(cat); else collapsed.add(cat); refresh(); });
        els.push(head);
        if (shut) continue;
        for (const d of inCat) { els.push(rowEl(d)); rowOrder.push(d.name); }
      }
    }
    list.replaceChildren(...els);

    // Description pane
    desc.replaceChildren(...(active ? [h('b', {}, active), h('div', {}, describeProperty(active))] : []));

    lockIfRunning();

    const f = focusEl as HTMLElement | null;
    if (hadFocus && f) {
      f.focus();
      if (f instanceof HTMLInputElement && !f.readOnly) f.select();
    }
  }

  /** A standard module: the object box and a single (Name) row; a class module also has Instancing. */
  function renderModule(m: ModuleDef, hadFocus: boolean): void {
    root.classList.remove('pw98-empty');
    objectEntries = [];
    const isClass = m.kind === 'class';
    const label = `${m.name} ${isClass ? 'Class Module' : 'Module'}`;
    objectCombo.setItems([label]);
    objectCombo.setValue(label);
    const names = isClass ? [NAME_DEF.name, INSTANCING] : [NAME_DEF.name];
    if (active && !names.includes(active)) active = null;
    const myEpoch = epoch;
    let done = false;
    const live = () => !done && myEpoch === epoch && ide.mode === 'design';
    let focusEl: HTMLElement | null = null;
    const instancing = INSTANCING_VALUES.find(v => v.value === (m.instancing ?? 1)) ?? INSTANCING_VALUES[0];
    const rowEls = names.map(name => {
      const cell = h('div', { class: 'pw98-value' });
      const row = h('div', { class: `pw98-row${active === name ? ' selected' : ''}`, 'data-prop': name, tabindex: '-1' },
        h('div', { class: 'pw98-name' }, name), cell);
      if (active === name && name === NAME_DEF.name) {
        focusEl = inlineEditor(NAME_DEF, m.name, live, t => { if (!live()) return; done = true; void setModuleName(m, t); });
        cell.replaceChildren(focusEl);
      } else if (active === name) {
        const combo = createCombo({ items: INSTANCING_VALUES.map(v => v.label), value: instancing.label, openOnClick: false, onChange: t => {
          const v = INSTANCING_VALUES.find(x => x.label === t);
          if (!live() || !v || v.value === (m.instancing ?? 1)) return;
          wantFocus = true;
          ide.stack.execute(setInstancingCmd(m.id, v.value));
        } });
        cell.replaceChildren(combo.el);
        focusEl = combo.el.querySelector('input') ?? row;
      } else cell.textContent = name === NAME_DEF.name ? m.name : instancing.label;
      if (active === name && !focusEl) focusEl = row;
      const activate = (e: Event) => {
        if (ide.mode !== 'design' || active === name) return;
        if (e.type === 'mousedown') e.preventDefault();
        select(name);
      };
      row.addEventListener('mousedown', activate);
      row.addEventListener('click', activate);
      return row;
    });
    if (!focusEl) focusEl = rowEls[0];
    rowOrder = names;
    lists[1 - tabs.selected].replaceChildren();
    lists[tabs.selected].replaceChildren(...rowEls);
    desc.replaceChildren(...(active ? [h('b', {}, active), h('div', {}, describeProperty(active))] : []));
    lockIfRunning();
    const fe = focusEl as HTMLElement | null;
    if (hadFocus && fe) { fe.focus(); if (fe instanceof HTMLInputElement && !fe.readOnly) fe.select(); }
  }

  /** Read-only while a program runs or is in break mode (edit-and-continue comes in phase 6). */
  function lockIfRunning(): void {
    if (ide.mode !== 'design') for (const el of root.querySelectorAll<HTMLElement>('input, textarea, select, button')) el.setAttribute('disabled', '');
    root.classList.toggle('pw98-readonly', ide.mode !== 'design');
    objectCombo.el.querySelector('input')!.disabled = false;   // the object box still selects
  }

  function select(name: string): void {
    if (flushEdit && !flushEdit()) return;   // invalid text: stay on the row (the message box restores it)
    active = name;
    wantFocus = true;
    refresh();
  }

  function cycleOrOpen(form: FormDef, ts: Target[], d: PropDef, v: PropValue | undefined): void {
    if (d.kind === 'bool' || d.kind === 'enum') {
      const cs = choices(d);
      const i = cs.findIndex(c => JSON.stringify(c.value) === JSON.stringify(v));
      wantFocus = true;
      void applyValue(form, ts, d, cs[(i + 1) % cs.length].value);
    } else openActive?.();
  }

  // ---- keyboard ------------------------------------------------------------------------------------------------
  root.addEventListener('keydown', e => {
    const t = e.target as HTMLElement;
    const list = lists[tabs.selected];
    if (e.defaultPrevented || ide.mode !== 'design' || !list.contains(t)) return;
    const inField = t.tagName === 'INPUT' && !(t as HTMLInputElement).readOnly;
    const move = (delta: number) => {
      e.preventDefault();
      if (!rowOrder.length) return;
      const i = active ? rowOrder.indexOf(active) : -1;
      const next = i < 0 ? 0 : Math.max(0, Math.min(rowOrder.length - 1, i + delta));
      if (rowOrder[next] !== active) select(rowOrder[next]);
    };
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.ctrlKey && !e.metaKey) return move(e.key === 'ArrowDown' ? 1 : -1);
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return move(e.shiftKey ? -1 : 1);
    // Ctrl+Shift+<letter>: next property starting with that letter
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1] ?? (/^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : null);
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && letter) {
      e.preventDefault();
      e.stopPropagation();
      const i = active ? rowOrder.indexOf(active) : -1;
      for (let k = 1; k <= rowOrder.length; k++) {
        const n = rowOrder[(i + k) % rowOrder.length];
        if (n.replace(/^\(/, '').toUpperCase().startsWith(letter)) { if (n !== active) select(n); break; }
      }
      return;
    }
    if (inField) return;
    const d = active ? getActiveDef() : undefined;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
      // consumed: Delete in the Properties window never deletes the selected control
      e.preventDefault();
      e.stopPropagation();
      const form = currentForm();
      const ts = form && d?.kind === 'picture' ? targets(form) : [];
      if (form && d && ts.some(x => x.props[d.name] != null)) setValue(form, ts, d, null, dropPictures(ts, d));
      return;
    }
    if (!d || t.closest('.cb98')) return;   // dropdown lists handle their own keys (first-letter selection)
    if (e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      openActive?.();
    }
  });

  const getActiveDef = (): PropDef | undefined => {
    if (active === NAME_DEF.name) return NAME_DEF;
    const form = currentForm();
    if (!form || !active) return undefined;
    return active === INDEX_DEF.name && targets(form)[0].id !== 'form' ? INDEX_DEF : getPropDef(targets(form)[0].type, active);
  };

  const isModule = (id: string | null) => !!id && ide.project.modules.some(m => m.id === id);
  // The Project Explorer clears the form selection when it selects a module; any form selection shows the form again.
  ide.on('selection', () => { moduleId = ide.selection === null && isModule(ide.explorerItemId) ? ide.explorerItemId : null; refresh(); });
  ide.on('project', refresh);
  ide.on('activeView', () => {
    const v = ide.activeView;
    moduleId = v.kind === 'code' && isModule(v.itemId) ? v.itemId : null;
    refresh();
  });
  ide.on('mode', refresh);
  refresh();
  return {
    refresh,
    commitPendingEdit: () => (flushEdit ? flushEdit() : true),
    focus() {
      const el = root.querySelector<HTMLElement>('.pw98-row.selected .pw98-editor, .pw98-row.selected .cb98-input, .pw98-row.selected')
        ?? root.querySelector<HTMLElement>('.pw98-row');
      el?.focus();
    },
  };
}
