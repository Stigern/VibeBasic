// Project Explorer: tree of the project's forms and modules, plus Add / Remove commands.
// Selection lives in `ide.explorerItemId` so the Project menu ("Remove <name>") can follow it.
import { addFormCmd, addModuleCmd, removeItemCmd } from '../model/commands';
import { newForm, newId } from '../model/controls';
import { h } from '../ui98/dom';
import { messageBox98 } from '../ui98/dialogs';
import { popupMenu } from '../ui98/popup';
import { openCodeWindow } from './codeWindow';
import { openDesigner, type DesignerEnv } from './designer';
import { OPTION_EXPLICIT, type IdeState } from './ideState';
import type { IdeActions } from './menus';

const VB_OK_EXCL = 48;

export interface ProjectExplorer {
  el: HTMLElement;
  /** Id of the selected form/module, or null. */
  selected(): string | null;
  select(id: string | null): void;
  focus(): void;
}

function nextFreeName(ide: IdeState, prefix: 'Form' | 'Module'): string {
  const taken = new Set([...ide.project.forms, ...ide.project.modules].map(i => i.name.toLowerCase()));
  let n = 1;
  while (taken.has(`${prefix}${n}`.toLowerCase())) n++;
  return `${prefix}${n}`;
}

export function addForm(ide: IdeState, env?: DesignerEnv): void {
  if (ide.mode !== 'design') return;
  const form = newForm(nextFreeName(ide, 'Form'), ide.options.requireVariableDeclaration ? OPTION_EXPLICIT : '');
  ide.stack.execute(addFormCmd(form));
  ide.explorerItemId = form.id;
  ide.setSelection({ formId: form.id, ids: [] });
  if (env) openDesigner(ide, form.id, env);
}

export function addModule(ide: IdeState, env?: DesignerEnv): void {
  if (ide.mode !== 'design') return;
  const m = { id: newId(), name: nextFreeName(ide, 'Module'), code: ide.options.requireVariableDeclaration ? OPTION_EXPLICIT : '' };
  ide.stack.execute(addModuleCmd(m));
  ide.explorerItemId = m.id;
  ide.setSelection(null);   // the Properties window shows the module
  if (env) openCodeWindow(ide, m.id, env);
}

/** Removes a form or module (undoable). The last form cannot be removed; removing the startup form makes the
 *  first remaining form the startup form. Open windows for the item close themselves on the 'project' event. */
export function removeItem(ide: IdeState, id: string): void {
  if (ide.mode !== 'design') return;
  const p = ide.project;
  const form = p.forms.find(f => f.id === id);
  if (!form && !p.modules.some(m => m.id === id)) return;
  if (form && p.forms.length === 1) {
    void messageBox98(document, { prompt: 'A project must contain at least one form.', title: 'VibeBasic', buttons: VB_OK_EXCL });
    return;
  }
  const replacement = form && form.name === p.startupForm ? p.forms.find(f => f.id !== id)!.name : undefined;
  ide.stack.execute(removeItemCmd(id, replacement));
  if (ide.explorerItemId === id) ide.explorerItemId = null;
  if (ide.selection?.formId === id) ide.selection = null;
  const v = ide.activeView;
  if ((v.kind === 'designer' && v.formId === id) || (v.kind === 'code' && v.itemId === id)) ide.setActiveView({ kind: 'none' });
  ide.emit('selection');
}

/** Registers addForm / addModule / removeItem (removes the selected item, else the active one). */
export function registerProjectActions(ide: IdeState, actions: IdeActions, env: DesignerEnv): void {
  actions.addForm = () => addForm(ide, env);
  actions.addModule = () => addModule(ide, env);
  actions.removeItem = (id?: string) => { const t = id ?? ide.currentItemId(); if (t) removeItem(ide, t); };
}

export function createProjectExplorer(host: HTMLElement, ide: IdeState, env?: DesignerEnv): ProjectExplorer {
  const doc = host.ownerDocument;
  const designerEnv: DesignerEnv = env ?? { mdiHost: doc.body };
  let flat = false;

  const isForm = (id: string | null) => !!id && ide.project.forms.some(f => f.id === id);
  const viewCode = (id: string | null) => { if (id && (isForm(id) || ide.project.modules.some(m => m.id === id))) openCodeWindow(ide, id, designerEnv); };
  const viewObject = (id: string | null) => { if (id && isForm(id)) openDesigner(ide, id, designerEnv); };
  const select = (id: string | null) => {
    ide.explorerItemId = id;
    // a module: no form selection, so the Properties window shows the module ((Name), VB6)
    if (isForm(id)) ide.setSelection({ formId: id!, ids: [] }); else if (id) ide.setSelection(null); else ide.emit('selection');
  };

  const btn = (label: string, title: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'pe98-btn', title }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const buttons = h('div', { class: 'pe98-buttons' },
    btn('View Code', 'View Code', () => viewCode(ide.explorerItemId)),
    btn('View Object', 'View Object', () => viewObject(ide.explorerItemId)),
    btn('Toggle Folders', 'Toggle Folders', () => { flat = !flat; render(); }));
  const tree = h('div', { class: 'pe98-tree', tabindex: '0' });
  const el = h('div', { class: 'pe98' }, buttons, tree);
  host.appendChild(el);

  const fileLabel = () => {
    const base = ide.filePath ? ide.filePath.split(/[\\/]/).pop() : null;
    return `${ide.project.name} (${base || `${ide.project.name}.vbb`})`;
  };

  function row(text: string, level: number, kind: 'project' | 'folder' | 'form' | 'module', id?: string): HTMLElement {
    const r = h('div', { class: `pe98-row pe98-${kind}${id && id === ide.explorerItemId ? ' selected' : ''}`, dataset: { kind, ...(id ? { id } : {}) }, style: `padding-left:${4 + level * 14}px` }, text);
    if (id) {
      r.addEventListener('mousedown', () => select(id));
      r.addEventListener('dblclick', () => (kind === 'form' ? viewObject(id) : viewCode(id)));
      r.addEventListener('contextmenu', e => {
        e.preventDefault();
        select(id);
        const name = [...ide.project.forms, ...ide.project.modules].find(i => i.id === id)?.name ?? '';
        popupMenu(doc, e.clientX, e.clientY, [
          { label: 'View Code', action: () => viewCode(id) },
          { label: 'View Object', action: () => viewObject(id) },
          { label: `Remove ${name}`, action: () => removeItem(ide, id) },
        ]);
      });
    }
    return r;
  }

  function render(): void {
    const p = ide.project;
    const rows: HTMLElement[] = [row(fileLabel(), 0, 'project')];
    const forms = p.forms.map(f => row(`${f.name} (${f.name})`, flat ? 1 : 2, 'form', f.id));
    const mods = p.modules.map(m => row(`${m.name} (${m.name})`, flat ? 1 : 2, 'module', m.id));
    if (flat) rows.push(...forms, ...mods);
    else {
      rows.push(row('Forms', 1, 'folder'), ...forms);
      if (mods.length) rows.push(row('Modules', 1, 'folder'), ...mods);
    }
    tree.replaceChildren(...rows);
  }

  const markSelected = () => {
    for (const r of tree.querySelectorAll<HTMLElement>('.pe98-row[data-id]')) r.classList.toggle('selected', r.dataset.id === ide.explorerItemId);
  };
  ide.on('project', () => {
    if (ide.explorerItemId && !ide.project.forms.some(f => f.id === ide.explorerItemId) && !ide.project.modules.some(m => m.id === ide.explorerItemId)) ide.explorerItemId = null;
    render();
  });
  ide.on('selection', markSelected);
  ide.on('activeView', () => {
    const v = ide.activeView;
    const id = v.kind === 'designer' ? v.formId : v.kind === 'code' ? v.itemId : null;
    if (id) ide.explorerItemId = id;
    markSelected();
  });
  render();

  return { el, selected: () => ide.explorerItemId, select, focus: () => tree.focus() };
}
