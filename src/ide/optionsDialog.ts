// Tools > Options: Editor, Editor Format and General tabs. Plan 05 pushes a builder for the "AI" tab onto `optionsTabs`.
import { getBackend, type Backend } from '../backend/backend';
import { h } from '../ui98/dom';
import { check, field, runTabbedDialog, type DialogTab, type DialogTabBuilder } from './projectDialogs';
import type { IdeState } from './ideState';

export const optionsTabs: DialogTabBuilder[] = [];

export { check };
/** Code window font sizes (px). */
export const FONT_SIZES = [9, 10, 11, 12, 13, 14, 15, 16];
const positiveInt = (s: string): boolean => /^\d+$/.test(s.trim()) && Number(s) > 0;

export async function showOptions(ide: IdeState, backend: Pick<Backend, 'saveSettings'> = getBackend(), doc: Document = document, initialTab?: string): Promise<void> {
  const o = ide.options;
  const syntax = check('Auto Syntax Check', o.autoSyntaxCheck);
  const reqDecl = check('Require Variable Declaration', o.requireVariableDeclaration);
  const grid = check('Show Grid', o.showGrid);
  const w = h('input', { type: 'text', value: String(o.gridWidth), class: 'dlgform98-num' });
  const hh = h('input', { type: 'text', value: String(o.gridHeight), class: 'dlgform98-num' });
  const align = check('Align Controls to Grid', o.alignToGrid);
  const prompt = check('Prompt for project at startup', o.promptForProject);
  const procSep = check('Procedure Separator', o.procedureSeparator);
  const palette = h('select', { class: 'dlgform98-select' },
    h('option', { value: 'vs' }, 'Visual Studio (default)'), h('option', { value: 'vb6' }, 'Classic VB6'));
  palette.value = o.codePalette;
  const size = h('select', { class: 'dlgform98-select' }, ...FONT_SIZES.map(n => h('option', { value: String(n) }, String(n))));
  size.value = String(FONT_SIZES.includes(o.codeFontSize) ? o.codeFontSize : 13);

  const editor: DialogTab = { label: 'Editor', content: h('div', { class: 'dlgform98' }, syntax.el, reqDecl.el, procSep.el) };
  const format: DialogTab = { label: 'Editor Format', content: h('div', { class: 'dlgform98' }, field('Colors:', palette), field('Size:', size)) };
  const general: DialogTab = {
    label: 'General',
    content: h('div', { class: 'dlgform98' }, grid.el, field('Grid Width (twips):', w), field('Grid Height (twips):', hh), align.el, prompt.el),
    validate: () => (positiveInt(w.value) && positiveInt(hh.value) ? null : 'Invalid property value'),
  };
  const tabs = [editor, format, general, ...optionsTabs.map(b => b(ide, doc))];
  await runTabbedDialog(doc, 'Options', tabs, () => {
    ide.setOptions({
      autoSyntaxCheck: syntax.input.checked, requireVariableDeclaration: reqDecl.input.checked,
      showGrid: grid.input.checked, gridWidth: Number(w.value), gridHeight: Number(hh.value), alignToGrid: align.input.checked,
      procedureSeparator: procSep.input.checked, codePalette: palette.value === 'vb6' ? 'vb6' : 'vs', codeFontSize: Number(size.value),
      promptForProject: prompt.input.checked,
    });
    void backend.saveSettings('ide', ide.options);
  }, Math.max(0, tabs.findIndex(t => t.label === initialTab)));
}
