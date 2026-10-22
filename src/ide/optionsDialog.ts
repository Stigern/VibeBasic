// Tools > Options: Editor and General tabs. Plan 05 pushes a builder for the "AI" tab onto `optionsTabs`.
import { getBackend, type Backend } from '../backend/backend';
import { h } from '../ui98/dom';
import { field, runTabbedDialog, type DialogTab, type DialogTabBuilder } from './projectDialogs';
import type { IdeState } from './ideState';

export const optionsTabs: DialogTabBuilder[] = [];

const check = (label: string, on: boolean): { el: HTMLElement; input: HTMLInputElement } => {
  const input = h('input', { type: 'checkbox', checked: on });
  return { input, el: h('label', { class: 'dlgform98-check' }, input, h('span', {}, label)) };
};
const positiveInt = (s: string): boolean => /^\d+$/.test(s.trim()) && Number(s) > 0;

export async function showOptions(ide: IdeState, backend: Pick<Backend, 'saveSettings'> = getBackend(), doc: Document = document): Promise<void> {
  const o = ide.options;
  const syntax = check('Auto Syntax Check', o.autoSyntaxCheck);
  const reqDecl = check('Require Variable Declaration', o.requireVariableDeclaration);
  const grid = check('Show Grid', o.showGrid);
  const w = h('input', { type: 'text', value: String(o.gridWidth), class: 'dlgform98-num' });
  const hh = h('input', { type: 'text', value: String(o.gridHeight), class: 'dlgform98-num' });
  const align = check('Align Controls to Grid', o.alignToGrid);

  const editor: DialogTab = { label: 'Editor', content: h('div', { class: 'dlgform98' }, syntax.el, reqDecl.el) };
  const general: DialogTab = {
    label: 'General',
    content: h('div', { class: 'dlgform98' }, grid.el, field('Grid Width (twips):', w), field('Grid Height (twips):', hh), align.el),
    validate: () => (positiveInt(w.value) && positiveInt(hh.value) ? null : 'Invalid property value'),
  };
  const tabs = [editor, general, ...optionsTabs.map(b => b(ide, doc))];
  await runTabbedDialog(doc, 'Options', tabs, () => {
    ide.setOptions({
      autoSyntaxCheck: syntax.input.checked, requireVariableDeclaration: reqDecl.input.checked,
      showGrid: grid.input.checked, gridWidth: Number(w.value), gridHeight: Number(hh.value), alignToGrid: align.input.checked,
    });
    void backend.saveSettings('ide', ide.options);
  });
}
