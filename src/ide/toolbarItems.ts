// The IDE toolbar (VB6 order) and the position / size readouts at its right end.
import { controlPos } from '../model/geometry';
import type { ControlDef } from '../model/types';
import { h } from '../ui98/dom';
import type { ToolbarItem } from '../ui98/toolbar';
import { TOOLBAR_ICONS } from './icons/toolbarIcons';
import type { IdeState } from './ideState';
import { editEnabled, type EditCommand, type IdeActions } from './menus';
import { sizeOf } from './designerLogic';

export interface IdeToolbarItem extends ToolbarItem { actionName?: string }

export function buildToolbarItems(actions: IdeActions, state: IdeState): IdeToolbarItem[] {
  const design = () => state.mode === 'design';
  const tb = (icon: string, title: string, name: string, pred?: () => boolean): IdeToolbarItem => ({
    icon: TOOLBAR_ICONS[icon], title, actionName: name, action: () => actions[name]?.(), enabled: () => !!actions[name] && (pred ? pred() : true),
  });
  const edit = (icon: string, title: string, cmd: EditCommand) => tb(icon, title, cmd, () => editEnabled(state, cmd));
  const sep: ToolbarItem = { separator: true };
  const inCode = () => state.activeView.kind === 'code';
  return [
    tb('new', 'New Project', 'newProject', design), sep,
    tb('addForm', 'Add Form', 'addForm', design), tb('addModule', 'Add Module', 'addModule', design),
    tb('menuEditor', 'Menu Editor', 'menuEditor', () => design() && state.activeView.kind === 'designer'), sep,
    tb('open', 'Open Project', 'openProject', design), tb('save', 'Save Project', 'saveProject'), sep,
    edit('cut', 'Cut', 'cut'), edit('copy', 'Copy', 'copy'), edit('paste', 'Paste', 'paste'), tb('find', 'Find', 'find', inCode), sep,
    tb('undo', 'Undo', 'undo', () => design() && (state.activeView.kind === 'code' || state.stack.canUndo)),
    tb('redo', 'Redo', 'redo', () => design() && (state.activeView.kind === 'code' || state.stack.canRedo)), sep,
    tb('start', 'Start', 'start', () => !state.busy && state.mode !== 'run'), tb('break', 'Break', 'break', () => state.mode === 'run'),
    tb('end', 'End', 'end', () => state.mode !== 'design'), sep,
    tb('projectExplorer', 'Project Explorer', 'viewProjectExplorer'), tb('properties', 'Properties Window', 'viewProperties'),
    tb('toolbox', 'Toolbox', 'viewToolbox'), tb('immediate', 'Immediate Window', 'viewImmediate'),
  ];
}

/** "Left, Top" and "Width x Height" (twips) of the selected control, or of the form when only the form is selected. */
export function geometryReadout(state: IdeState): { pos: string; size: string } {
  const none = { pos: '', size: '' };
  const v = state.activeView, sel = state.selection;
  if (state.mode !== 'design' || v.kind !== 'designer' || !sel || sel.formId !== v.formId) return none;
  const form = state.project.forms.find(f => f.id === v.formId);
  if (!form) return none;
  const num = (x: unknown) => (typeof x === 'number' ? x : Number(x) || 0);
  const id = sel.ids[sel.ids.length - 1];
  if (!id) return { pos: `${num(form.props.Left)}, ${num(form.props.Top)}`, size: `${num(form.props.Width)} x ${num(form.props.Height)}` };
  const c: ControlDef | undefined = form.controls.find(k => k.id === id);
  if (!c || c.type === 'Menu') return none;   // a menu (picked in the Properties window) has no position
  const p = controlPos(c), sz = sizeOf(c);
  return { pos: `${p.left}, ${p.top}`, size: 'Width' in c.props || c.type === 'Line' ? `${sz.width} x ${sz.height}` : '' };
}

/** Two sunken boxes with a small icon each, appended to the toolbar host. */
export function createReadouts(host: HTMLElement, state: IdeState): { refresh(): void } {
  const mk = (icon: string, title: string) => {
    const text = h('span', { class: 'tb98-readout-text' });
    const box = h('span', { class: 'tb98-readout', title });
    const holder = h('span', { class: 'tb98-icon' });
    holder.innerHTML = TOOLBAR_ICONS[icon];
    box.append(holder, text);
    return { box, text };
  };
  const pos = mk('position', 'Position (Left, Top) in twips'), size = mk('size', 'Size (Width x Height) in twips');
  host.append(h('span', { class: 'tb98-readouts' }, pos.box, size.box));
  const refresh = () => { const r = geometryReadout(state); pos.text.textContent = r.pos; size.text.textContent = r.size; };
  refresh();
  return { refresh };
}
