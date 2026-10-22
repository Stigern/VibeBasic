// @vitest-environment jsdom
// Edit menu / toolbar commands in code windows and the designer, their enabled state, toolbar focus behaviour,
// the position / size readouts and "every enabled item has a registered action".
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { BrowserBackend } from '../../src/backend/browserBackend';
import { startIde, type Ide } from '../../src/ide/main';
import { openCodeWindow } from '../../src/ide/codeWindow';
import { addControlsCmd } from '../../src/model/commands';
import { newControl } from '../../src/model/controls';
import { buildToolbarItems } from '../../src/ide/toolbarItems';
import { buildMenus } from '../../src/ide/menus';
import type { MenuItem } from '../../src/ui98/menubar';

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

let ide: Ide, root: HTMLElement, view: EditorView, clipText = '';
const form = () => ide.state.project.forms[0];
const viewOf = () => (openCodeWindow(ide.state, form().id) as unknown as { view: EditorView }).view;
const btn = (title: string) => root.querySelector<HTMLElement>(`.tb98-tool[title="${title}"]`)!;
const enabled = (title: string) => !btn(title).classList.contains('disabled');
const menuItem = (menu: string, label: string) => ide.menus.find(m => m.label === menu)!.items.find(i => i.label === label)!;
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
  clipText = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (t: string) => { clipText = t; }, readText: async () => clipText,
  } });
  ide = startIde(new BrowserBackend(), root);
  ide.actions.viewCode();
  view = viewOf();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'hello world' } });
});
afterEach(() => { document.body.innerHTML = ''; });

test('opening a code window focuses its editor', () => {
  expect(document.activeElement).toBe(view.contentDOM);
});

test('code window: copy, cut, paste, delete, select all via actions', async () => {
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  ide.actions.copy(); await flush();
  expect(clipText).toBe('hello');
  expect(view.state.doc.toString()).toBe('hello world');
  ide.actions.cut(); await flush();
  expect(view.state.doc.toString()).toBe(' world');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  ide.actions.paste(); await flush();
  expect(view.state.doc.toString()).toBe(' worldhello');
  view.dispatch({ selection: { anchor: 0, head: 1 } });
  ide.actions.delete();
  expect(view.state.doc.toString()).toBe('worldhello');
  view.dispatch({ selection: { anchor: 0 } });
  ide.actions.delete();                       // no selection: the next character
  expect(view.state.doc.toString()).toBe('orldhello');
  ide.actions.selectAll();
  expect(view.state.selection.main.from).toBe(0);
  expect(view.state.selection.main.to).toBe(view.state.doc.length);
  expect(document.activeElement).toBe(view.contentDOM);
});

test('code window: paste falls back silently when readText is refused', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { throw new Error('denied'); } } });
  view.dispatch({ selection: { anchor: 0 } });
  ide.actions.paste(); await flush();
  expect(view.state.doc.toString()).toBe('hello world');
});

test('enabled state follows the code selection', () => {
  view.dispatch({ selection: { anchor: 3 } });
  for (const t of ['Cut', 'Copy']) expect(enabled(t)).toBe(false);
  expect(enabled('Paste')).toBe(true);
  expect(menuItem('Edit', 'Delete').enabled!()).toBe(false);
  view.dispatch({ selection: { anchor: 0, head: 4 } });
  for (const t of ['Cut', 'Copy']) expect(enabled(t)).toBe(true);
  expect(menuItem('Edit', 'Cut').enabled!()).toBe(true);
  expect(menuItem('Edit', 'Delete').enabled!()).toBe(true);
  expect(enabled('Find')).toBe(true);
});

test('enabled state in the designer follows the selected controls and the control clipboard', () => {
  const f = form();
  const d = newControl(f, 'CommandButton', { left: 120, top: 240 }, null);
  ide.state.stack.execute(addControlsCmd(f.id, [d]));
  ide.actions.viewObject();
  ide.state.setSelection({ formId: f.id, ids: [] });
  expect(enabled('Cut')).toBe(false);
  expect(enabled('Find')).toBe(false);
  ide.state.setSelection({ formId: f.id, ids: [d.id] });
  expect(enabled('Cut')).toBe(true);
  expect(enabled('Copy')).toBe(true);
  expect(menuItem('Edit', 'Delete').enabled!()).toBe(true);
  ide.actions.copy();
  expect(enabled('Paste')).toBe(true);
  ide.actions.delete();
  expect(f.controls.length).toBe(0);   // the designer handler still works next to the code handler
});

test('toolbar and menu bar mousedown do not take focus away from the editor', () => {
  view.focus();
  for (const el of [btn('Copy'), root.querySelector<HTMLElement>('.mb98-top')!]) {
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  }
  expect(document.activeElement).toBe(view.contentDOM);
});

test('position and size readouts follow the selection and moves', () => {
  const f = form();
  const d0 = newControl(f, 'CommandButton', { left: 1200, top: 840 }, null);
  d0.props.Width = 1215; d0.props.Height = 495;
  ide.state.stack.execute(addControlsCmd(f.id, [d0]));
  const d = f.controls[f.controls.length - 1];
  ide.actions.viewObject();
  const [pos, size] = [...root.querySelectorAll('.tb98-readout-text')].map(e => e as HTMLElement);
  ide.state.setSelection({ formId: f.id, ids: [d.id] });
  expect(pos.textContent).toBe('1200, 840');
  expect(size.textContent).toBe('1215 x 495');
  d.props.Left = 1500;
  ide.state.emit('project');
  expect(pos.textContent).toBe('1500, 840');
  ide.state.setSelection({ formId: f.id, ids: [] });
  expect(size.textContent).toBe(`${f.props.Width} x ${f.props.Height}`);
  ide.actions.viewCode();
  expect(pos.textContent).toBe('');
  expect(size.textContent).toBe('');
});

test('every enabled menu item and toolbar button has a registered action', () => {
  const missing: string[] = [];
  const walk = (items: MenuItem[], path: string) => {
    for (const it of items) {
      if (it.separator) continue;
      if (it.submenu) { walk(it.submenu, `${path}/${it.label}`); continue; }
      if (it.enabled?.() && !it.action) missing.push(`${path}/${it.label}`);
    }
  };
  // a Proxy shows which action name each item's enabled() looked at: an enabled item must find a function there
  const looked: { name: string; fn: unknown }[] = [];
  const spy = new Proxy(ide.actions, { get: (t, k) => { looked.push({ name: String(k), fn: t[k as string] }); return t[k as string]; } });
  for (const m of buildMenus(spy, ide.state)) {
    for (const it of m.items.flatMap(i => i.submenu ?? [i])) {
      if (it.separator) continue;
      looked.length = 0;
      if (it.enabled!() && !looked.some(l => typeof l.fn === 'function')) missing.push(`${m.label}/${it.label}`);
    }
    walk(m.items, m.label);
  }
  for (const state of ['design', 'run', 'break'] as const) {
    ide.state.mode = state;
    for (const it of buildToolbarItems(ide.actions, ide.state)) {
      if (it.separator || !it.enabled!()) continue;
      if (!it.actionName || typeof ide.actions[it.actionName] !== 'function') missing.push(`toolbar/${it.title}`);
    }
  }
  expect(missing).toEqual([]);
});
