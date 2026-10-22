// Properties window: object list on top, alphabetic property list below. Edits go through IdeState.stack.
import { getBackend, type Backend } from '../backend/backend';
import { addAssetCmd, compositeCmd, renameCmd, setPropertyCmd, type Command } from '../model/commands';
import { CONTROL_TYPES, getPropDef, newId, validateName, type PropDef } from '../model/controls';
import type { ControlDef, ControlType, FontValue, FormDef, PropValue } from '../model/types';
import { messageBox98, vbYes } from '../ui98/dialogs';
import { createCombo, type Combo } from '../ui98/combo';
import { h } from '../ui98/dom';
import { createTabs } from '../ui98/tabs';
import type { IdeState } from './ideState';
import { bytesToBase64, createColorPopup, formatPropertyValue, mimeFromPath, parsePropertyInput, showFontDialog } from './propertyEditors';

const VB_OK_EXCL = 48, VB_YESNO_QUESTION = 4 | 32;
const NAME_DEF: PropDef = { name: '(Name)', kind: 'string', default: '', designTime: true, runtime: 'rw' };
const INDEX_DEF: PropDef = { name: 'Index', kind: 'int', default: 0, designTime: true, runtime: 'rw', min: 0 };
const DEFAULT_FONT: FontValue = { name: 'MS Sans Serif', size: 8, bold: false, italic: false, underline: false };

interface Target { id: string | 'form'; type: ControlType; name: string; index: number | null; props: Record<string, PropValue> }

export interface PropertiesWindow { refresh(): void; focus(): void }

export function createPropertiesWindow(host: HTMLElement, ide: IdeState, opts: { backend?: Backend } = {}): PropertiesWindow {
  const doc = host.ownerDocument;
  let active: string | null = null;
  let objectCombo: Combo | null = null;
  let objectEntries: { label: string; id: string | 'form' }[] = [];
  const listEl = h('div', { class: 'pw98-list' });
  const root = h('div', { class: 'pw98' });
  host.replaceChildren(root);

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

  const invalid = async () => { await messageBox98(doc, { prompt: 'Invalid property value', title: 'VibeBasic', buttons: VB_OK_EXCL }); refresh(); };

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
      ide.stack.execute(renameCmd(form.id, t.id, name, t.name.toLowerCase() === name.toLowerCase() ? t.index : null));
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

  async function setIndex(form: FormDef, t: Target, v: number): Promise<void> {
    if (form.controls.some(c => c.id !== t.id && c.name.toLowerCase() === t.name.toLowerCase() && c.index === v)) return invalid();
    if (v !== t.index) ide.stack.execute(renameCmd(form.id, t.id, t.name, v)); else refresh();
  }

  async function applyValue(form: FormDef, ts: Target[], def: PropDef, value: PropValue): Promise<void> {
    if (def === NAME_DEF) return typeof value === 'string' ? setName(form, ts[0], value) : undefined;
    if (def === INDEX_DEF) return setIndex(form, ts[0], value as number);
    if (ts.every(t => JSON.stringify(t.props[def.name] ?? def.default) === JSON.stringify(value))) { refresh(); return; }
    setValue(form, ts, def, value);
  }

  async function applyText(form: FormDef, ts: Target[], def: PropDef, text: string): Promise<void> {
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
    setValue(form, ts, def, { asset: id }, [addAssetCmd(id, { mime: mimeFromPath(path), dataBase64: bytesToBase64(bytes) })]);
  }

  function editorFor(form: FormDef, ts: Target[], def: PropDef, cell: HTMLElement, value: PropValue | undefined): void {
    const mixed = value === undefined && ts.length > 1;   // differing values in a multi-selection: blank
    const shown = mixed ? '' : formatPropertyValue(def, value);
    const text = mixed ? '' : def.kind === 'text' ? String(value ?? '') : def.kind === 'list' ? (Array.isArray(value) ? value.join('\n') : '') : shown;
    let done = false;
    const commit = (t: string) => { if (done || ide.mode !== 'design') return; done = true; void applyText(form, ts, def, t); };
    const mkInput = (multi: boolean) => {
      const el: HTMLInputElement | HTMLTextAreaElement = multi ? h('textarea', { class: 'pw98-editor', rows: '4' }) : h('input', { type: 'text', class: 'pw98-editor' });
      el.value = text;
      el.addEventListener('keydown', ((e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (multi && (e.ctrlKey || e.metaKey)) {
            const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
            el.value = el.value.slice(0, a) + '\n' + el.value.slice(b);
            el.selectionStart = el.selectionEnd = a + 1;
          } else commit(el.value);
        } else if (e.key === 'Escape') { done = true; refresh(); }
        e.stopPropagation();
      }) as EventListener);
      el.addEventListener('blur', () => { if (el.value !== text) commit(el.value); });
      return el;
    };
    switch (def.kind) {
      case 'bool': case 'enum': {
        const items = def.kind === 'bool' ? ['True', 'False'] : (def.enumValues ?? []).map(e => e.label);
        const combo = createCombo({ items, value: shown, onChange: v => commit(v) });
        cell.replaceChildren(combo.el);
        return;
      }
      case 'text': case 'list': cell.replaceChildren(mkInput(true)); return;
      case 'color': {
        const input = mkInput(false);
        let popup: HTMLElement | null = null;
        const close = () => { popup?.remove(); popup = null; };
        const btn = h('button', { type: 'button', class: 'pw98-btn', title: 'Pick colour', onclick: () => {
          if (popup) return close();
          popup = createColorPopup(n => commit(String(n)), close);
          cell.appendChild(popup);
        } }, '▾');
        cell.replaceChildren(input, btn);
        return;
      }
      case 'font': case 'picture': {
        const btn = h('button', { type: 'button', class: 'pw98-btn', title: '...', onclick: async () => {
          if (def.kind === 'picture') return pickPicture(form, ts, def);
          const cur = ts[0].props[def.name];
          const f = await showFontDialog(doc, cur && typeof cur === 'object' && 'name' in cur ? cur : DEFAULT_FONT);
          if (f) void applyValue(form, ts, def, f);
        } }, '...');
        cell.replaceChildren(h('span', { class: 'pw98-valtext' }, shown), btn);
        return;
      }
      default: cell.replaceChildren(mkInput(false));
    }
  }

  function refresh(): void {
    const form = currentForm();
    if (!form) { root.replaceChildren(); objectCombo = null; return; }
    const ts = targets(form);
    const multi = ts.length > 1;

    // Object list
    objectEntries = [{ label: labelOf(form.name, null, 'Form'), id: 'form' },
      ...form.controls.map((c: ControlDef) => ({ label: labelOf(c.name, c.index, c.type), id: c.id }))];
    const first = ts[0];
    const cur = multi ? '' : labelOf(first.name, first.index, first.type);
    objectCombo = createCombo({
      items: objectEntries.map(e => e.label), value: cur,
      onChange: v => {
        const e = objectEntries.find(x => x.label === v);
        if (e) ide.setSelection({ formId: form.id, ids: e.id === 'form' ? [] : [e.id] });
      },
    });

    // Rows: properties common to all selected types
    const defs = CONTROL_TYPES[first.type].props.filter(d => d.designTime).filter(d => ts.every(t => {
      const o = getPropDef(t.type, d.name);
      return o && o.designTime && o.kind === d.kind && (d.kind !== 'enum' || JSON.stringify(o.enumValues) === JSON.stringify(d.enumValues));
    }));
    const rows: PropDef[] = [...(multi ? [] : [NAME_DEF]), ...defs];
    if (!multi && first.index !== null) rows.push(INDEX_DEF);
    rows.sort((a, b) => (a === NAME_DEF ? -1 : b === NAME_DEF ? 1 : a.name.localeCompare(b.name)));
    if (active && !rows.some(r => r.name === active)) active = null;

    const valueOf = (d: PropDef): PropValue | undefined => {
      const get = (t: Target) => d === NAME_DEF ? t.name : d === INDEX_DEF ? t.index : t.props[d.name] ?? d.default;
      const v0 = get(first);
      return ts.every(t => JSON.stringify(get(t)) === JSON.stringify(v0)) ? v0 : undefined;
    };

    const rowEls = rows.map(d => {
      const v = valueOf(d);
      const cell = h('div', { class: 'pw98-value' });
      const row = h('div', { class: `pw98-row${active === d.name ? ' selected' : ''}`, 'data-prop': d.name, tabindex: '0' },
        h('div', { class: 'pw98-name' }, d.name), cell);
      if (active === d.name) editorFor(form, ts, d, cell, v);
      else cell.textContent = v === undefined && multi ? '' : formatPropertyValue(d, v);
      row.addEventListener('click', () => { if (ide.mode === 'design' && active !== d.name) { active = d.name; refresh(); (listEl.querySelector('.pw98-row.selected .pw98-editor, .pw98-row.selected input') as HTMLElement | null)?.focus(); } });
      row.addEventListener('keydown', e => {
        if (e.key === 'Delete' && d.kind === 'picture' && e.target === row) { e.preventDefault(); e.stopPropagation(); void applyValue(form, ts, d, null); }
      });
      return row;
    });
    listEl.replaceChildren(...rowEls);
    const tabs = createTabs([{ label: 'Alphabetic', content: listEl }]);
    root.replaceChildren(objectCombo.el, tabs.el);
    // Read-only while a program runs or is in break mode (edit-and-continue comes in phase 6)
    if (ide.mode !== 'design') for (const el of root.querySelectorAll<HTMLElement>('input, textarea, select, button')) el.setAttribute('disabled', '');
    root.classList.toggle('pw98-readonly', ide.mode !== 'design');
  }

  ide.on('selection', refresh);
  ide.on('project', refresh);
  ide.on('activeView', refresh);
  ide.on('mode', refresh);
  refresh();
  return {
    refresh,
    focus() { (root.querySelector('.pw98-row.selected .pw98-editor, .pw98-row.selected input, .pw98-row') as HTMLElement | null)?.focus(); },
  };
}
