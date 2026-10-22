// Project Properties and Project > Components dialogs, and the shared tabbed-dialog runner (also used by Options).
import { getBackend } from '../backend/backend';
import { addAssetCmd, compositeCmd, removeAssetCmd, setProjectFieldCmd, setProjectIconCmd, type Command } from '../model/commands';
import { availableComponents, componentDef, componentInUse, componentLocation, normalizeComponents, setComponentsCmd } from '../model/components';
import { newId } from '../model/controls';
import type { Asset, Project } from '../model/types';
import { bytesToBase64 } from './propertyEditors';
import { validateName } from '../model/controls';
import { createCombo } from '../ui98/combo';
import { h } from '../ui98/dom';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import { createTabs } from '../ui98/tabs';
import type { IdeState } from './ideState';

export interface DialogTab {
  label: string;
  content: HTMLElement;
  /** Returns an error message (shown in a MsgBox; the dialog stays open) or null when the tab is valid. */
  validate?(): string | null;
  /** Called on OK, after every tab validated. */
  apply?(): void;
  /** Project Properties only: undoable commands, executed together as one undo step. */
  commands?(): Command[];
}
export type DialogTabBuilder = (ide: IdeState, doc?: Document) => DialogTab;

/** Shows `tabs` with OK / Cancel. Resolves true when OK was pressed and all tabs were valid and applied. */
export async function runTabbedDialog(doc: Document, title: string, tabs: DialogTab[], onOk?: () => void, selected = 0): Promise<boolean> {
  const t = createTabs(tabs.map(x => ({ label: x.label, content: x.content })), { selected });
  for (;;) {
    const v = await showDialog98(doc, {
      title, content: t.el,
      buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }],
    });
    if (v !== 'ok') return false;
    let error: string | null = null;
    tabs.forEach((tab, i) => { if (error === null) { const e = tab.validate?.() ?? null; if (e !== null) { error = e; t.select(i); } } });
    if (error !== null) { await messageBox98(doc, { prompt: error, title: 'VibeBasic', buttons: 48 }); continue; }
    for (const tab of tabs) tab.apply?.();
    onOk?.();
    return true;
  }
}

export const field = (label: string, control: HTMLElement): HTMLElement => h('label', { class: 'dlgform98-row' }, h('span', {}, label), control);

/** Extra tabs for Project Properties. Plan 04 pushes a builder for the "Make" tab here. */
export const projectPropertiesTabs: DialogTabBuilder[] = [];

/** True when a form or module still refers to the asset (the project icon is not counted). */
function assetUsedElsewhere(p: Project, id: string): boolean {
  return JSON.stringify([p.forms, p.modules]).includes(`"asset":${JSON.stringify(id)}`);
}

/** Make tab: the icon of made apps. Stored in project.assets / project.iconAsset, one undo step. */
function makeTab(ide: IdeState, doc: Document = document): DialogTab {
  const p = ide.project;
  // undefined: unchanged; null: cleared; otherwise a newly picked PNG
  let pending: { id: string; asset: Asset } | null | undefined;
  const current = (): Asset | null => {
    if (pending !== undefined) return pending ? pending.asset : null;
    return p.iconAsset ? p.assets[p.iconAsset] ?? null : null;
  };
  const preview = h('img', { class: 'dlgform98-icon', width: '32', height: '32', alt: '' }) as HTMLImageElement;
  const clear = h('button', { type: 'button' }, 'Clear') as HTMLButtonElement;
  const refresh = () => {
    const a = current();
    if (a) preview.src = `data:${a.mime};base64,${a.dataBase64}`; else preview.removeAttribute('src');
    preview.style.visibility = a ? 'visible' : 'hidden';
    clear.disabled = !a;
  };
  const browse = h('button', { type: 'button' }, 'Browse...') as HTMLButtonElement;
  browse.addEventListener('click', async () => {
    try {
      const backend = getBackend();
      const path = await backend.openFileDialog([{ name: 'PNG image', extensions: ['png'] }]);
      if (!path) return;
      const bytes = await backend.readBinaryFile(path);
      pending = { id: `asset-${newId()}`, asset: { mime: 'image/png', dataBase64: bytesToBase64(bytes) } };
      refresh();
    } catch (e) {
      await messageBox98(doc, { prompt: e instanceof Error ? e.message : String(e), title: 'VibeBasic', buttons: 16 });
    }
  });
  clear.addEventListener('click', () => { pending = null; refresh(); });
  refresh();
  return {
    label: 'Make',
    content: h('div', { class: 'dlgform98' }, field('Icon:', h('span', {}, preview, browse, clear))),
    commands: () => {
      if (pending === undefined) return [];
      const old = p.iconAsset;
      const drop = old !== null && old in p.assets && !assetUsedElsewhere(p, old) ? [removeAssetCmd(old)] : [];
      if (pending === null) return old === null ? [] : [setProjectIconCmd(null), ...drop];
      return [addAssetCmd(pending.id, pending.asset), setProjectIconCmd(pending.id), ...drop];
    },
  };
}
projectPropertiesTabs.push(makeTab);

function generalTab(ide: IdeState): DialogTab {
  const p = ide.project;
  const name = h('input', { type: 'text', value: p.name, 'data-autofocus': '' });
  const startup = createCombo({ items: p.forms.map(f => f.name), value: p.startupForm });
  const title = h('input', { type: 'text', value: p.title });
  return {
    label: 'General',
    content: h('div', { class: 'dlgform98' }, field('Project Name:', name), field('Startup Object:', startup.el), field('Application Title:', title)),
    validate: () => (validateName(name.value) ? null : 'Invalid property value'),
    commands: () => {
      const cmds: Command[] = [];
      if (name.value !== p.name) cmds.push(setProjectFieldCmd('name', name.value));
      if (startup.getValue() !== p.startupForm && p.forms.some(f => f.name === startup.getValue())) cmds.push(setProjectFieldCmd('startupForm', startup.getValue()));
      if (title.value !== p.title) cmds.push(setProjectFieldCmd('title', title.value));
      return cmds;
    },
  };
}

export async function showProjectProperties(ide: IdeState, doc: Document = document): Promise<void> {
  const tabs = [generalTab(ide), ...projectPropertiesTabs.map(b => b(ide, doc))];
  await runTabbedDialog(doc, `${ide.project.name} - Project Properties`, tabs, () => {
    const cmds = tabs.flatMap(t => t.commands?.() ?? []);
    if (cmds.length) ide.stack.execute(compositeCmd('Project Properties', cmds));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Project > Components (Ctrl+T)

/** VB6's message when a component that a form uses is unchecked. */
export const COMPONENT_IN_USE = "Can't remove control or reference; in use";

/** What Apply / OK does with the checked boxes: a component in use stays checked (`refused`). */
export function applyComponentChoice(p: Project, wanted: readonly string[]): { components: string[]; refused: string[] } {
  const want = new Set(wanted.map(w => w.toUpperCase()));
  const refused = p.components.filter(c => !want.has(c.toUpperCase()) && componentInUse(p, c));
  return { components: normalizeComponents(wanted, refused), refused };
}

/** The Controls tab lists the components (checkbox and name, alphabetical); the frame at the bottom names the selected one
 *  and its file. OK and Apply change the project's components at once (the Toolbox follows); a component a form uses
 *  cannot be unchecked. */
export async function showComponents(ide: IdeState, doc: Document = document): Promise<void> {
  const all = availableComponents().sort((a, b) => a.name.localeCompare(b.name));
  const checked = new Set(ide.project.components.map(c => c.toUpperCase()));
  let current = all[0]?.file ?? '';
  const list = h('div', { class: 'cmp98-list', role: 'listbox', tabindex: '0', 'data-autofocus': '' });
  const nameEl = h('legend', {}), locEl = h('div', { class: 'cmp98-loc' });
  // 98.css draws a checkbox as `input + label[for]`
  const only = h('input', { type: 'checkbox', id: 'cmp98-only' }) as HTMLInputElement;
  const showInfo = () => {
    const c = componentDef(current);
    nameEl.textContent = c?.name ?? '';
    locEl.textContent = c ? `Location: ${componentLocation(c)}` : '';
  };
  const render = () => {
    const rows = all.filter(c => !only.checked || checked.has(c.file)).map(c => {
      const id = `cmp98-${c.file}`;
      const box = h('input', { type: 'checkbox', id, checked: checked.has(c.file), 'data-file': c.file }) as HTMLInputElement;
      box.addEventListener('change', () => { if (box.checked) checked.add(c.file); else checked.delete(c.file); });
      const row = h('div', { class: c.file === current ? 'cmp98-row selected' : 'cmp98-row', 'data-file': c.file }, box, h('label', { for: id }, c.name));
      row.addEventListener('mousedown', () => {
        current = c.file;
        for (const r of list.querySelectorAll('.cmp98-row')) r.classList.toggle('selected', r === row);
        showInfo();
      });
      return row;
    });
    list.replaceChildren(...rows);
  };
  only.addEventListener('change', render);
  list.addEventListener('keydown', e => {
    const i = all.findIndex(c => c.file === current);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { current = next.file; render(); showInfo(); }
    } else if (e.key === ' ' && current) {
      e.preventDefault();
      if (checked.has(current)) checked.delete(current); else checked.add(current);
      render();
    }
  });
  render();
  showInfo();
  const browse = h('button', { type: 'button', disabled: true }, 'Browse...');
  const side = h('div', { class: 'cmp98-side' }, browse, h('div', {}, only, h('label', { for: 'cmp98-only' }, 'Selected Items Only')));
  const body = h('div', { class: 'cmp98' },
    h('div', { class: 'cmp98-top' }, list, side),
    h('fieldset', { class: 'cmp98-info' }, nameEl, locEl));
  const tabs = createTabs([{ label: 'Controls', content: body }]);
  /** Applies the boxes; false when a component in use had to stay checked. */
  const apply = async (): Promise<boolean> => {
    const r = applyComponentChoice(ide.project, [...checked]);
    const now = normalizeComponents(ide.project.components);
    if (JSON.stringify(r.components) !== JSON.stringify(now)) ide.stack.execute(setComponentsCmd(r.components));
    if (!r.refused.length) return true;
    for (const f of r.refused) checked.add(f.toUpperCase());
    render();
    await messageBox98(doc, { prompt: COMPONENT_IN_USE, title: 'Components', buttons: 48 });
    return false;
  };
  for (;;) {
    const v = await showDialog98(doc, {
      title: 'Components', content: tabs.el,
      buttons: [{ label: 'OK', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Apply', value: 'apply' }],
    });
    if (v !== 'ok' && v !== 'apply') return;
    const ok = await apply();
    if (v === 'ok' && ok) return;
  }
}
