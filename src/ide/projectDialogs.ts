// Project Properties dialog and the shared tabbed-dialog runner (also used by Options).
import { compositeCmd, setProjectFieldCmd, type Command } from '../model/commands';
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
export type DialogTabBuilder = (ide: IdeState) => DialogTab;

/** Shows `tabs` with OK / Cancel. Resolves true when OK was pressed and all tabs were valid and applied. */
export async function runTabbedDialog(doc: Document, title: string, tabs: DialogTab[], onOk?: () => void): Promise<boolean> {
  const t = createTabs(tabs.map(x => ({ label: x.label, content: x.content })));
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
  const tabs = [generalTab(ide), ...projectPropertiesTabs.map(b => b(ide))];
  await runTabbedDialog(doc, `${ide.project.name} - Project Properties`, tabs, () => {
    const cmds = tabs.flatMap(t => t.commands?.() ?? []);
    if (cmds.length) ide.stack.execute(compositeCmd('Project Properties', cmds));
  });
}
