// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { ACTION_NAMES, buildMenus } from '../../src/ide/menus';
import { IdeState } from '../../src/ide/ideState';
import { startIde } from '../../src/ide/main';
import { BrowserBackend } from '../../src/backend/browserBackend';
import type { MenuItem } from '../../src/ui98/menubar';

afterEach(() => { document.body.innerHTML = ''; });
const find = (label: string, menu: string, ...r: Parameters<typeof buildMenus>) =>
  buildMenus(...r).find(m => m.label === menu)!.items.find(i => i.label === label)!;

test('menu labels', () => expect(buildMenus({}).map(m => m.label)).toEqual(['File', 'Edit', 'View', 'Project', 'Format', 'Debug', 'Run', 'Tools', 'Help']));
test('missing actions disabled', () => {
  const run = buildMenus({}).find(m => m.label === 'Run')!;
  expect(run.items[0].enabled!()).toBe(false);
});
test('registered action enables item and runs it', () => {
  const start = vi.fn();
  const it = find('Start', 'Run', { start });
  expect(it.enabled!()).toBe(true);
  it.action!();
  expect(start).toHaveBeenCalled();
});
test('make item and project-properties use project name', () => {
  const s = new IdeState();
  s.project.name = 'Kalk';
  expect(find('Make Kalk.app...', 'File', {}, s).label).toBe('Make Kalk.app...');
  const items = buildMenus({}, s).find(m => m.label === 'Project')!.items;
  expect(items.map(i => i.label)).toContain('Kalk Properties...');
  expect(items.map(i => i.label)).toContain('Remove Form1');
});
test('shortcuts and submenus', () => {
  const all = buildMenus({});
  const debug = all.find(m => m.label === 'Debug')!.items;
  expect(debug.map(i => [i.label, i.shortcut])).toEqual([
    ['Step Into', 'F8'], ['Step Over', 'Shift+F8'], ['Step Out', 'Ctrl+Shift+F8'], ['Run To Cursor', 'Ctrl+F8'], ['-', undefined],
    ['Add Watch...', undefined], ['Edit Watch...', 'Ctrl+W'], ['Quick Watch...', 'Shift+F9'], ['-', undefined],
    ['Toggle Breakpoint', 'F9'], ['Clear All Breakpoints', 'Ctrl+Shift+F9'], ['-', undefined],
    ['Set Next Statement', 'Ctrl+F9'], ['Show Next Statement', undefined],
  ]);
  const sc = (l: string, m: string) => all.find(x => x.label === m)!.items.find(i => i.label === l)!.shortcut;
  expect(sc('Redo', 'Edit')).toBe('Ctrl+Y');
  expect(sc('Break', 'Run')).toBe('Ctrl+Break');
  expect(sc('Properties Window', 'View')).toBe('F4');
  const format = all.find(m => m.label === 'Format')!.items;
  const sub = (l: string) => (format.find(i => i.label === l)!.submenu as MenuItem[]).map(i => i.label);
  expect(sub('Align')).toEqual(['Lefts', 'Centers', 'Rights', 'Tops', 'Middles', 'Bottoms']);
  expect(sub('Make Same Size')).toEqual(['Width', 'Height', 'Both']);
  expect(sub('Order')).toEqual(['Bring to Front', 'Send to Back']);
});
test('action names exported', () => {
  expect(ACTION_NAMES).toContain('viewCode');
  expect(new Set(ACTION_NAMES).size).toBe(ACTION_NAMES.length);
});
test('undo item follows the command stack', () => {
  const s = new IdeState();
  expect(find('Undo', 'Edit', { undo: () => {} }, s).enabled!()).toBe(false);
});

test('startIde builds shell: toolbox, toolbar, designer window, immediate hidden', () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const be = new BrowserBackend();
  const title = vi.spyOn(be, 'setWindowTitle');
  const ide = startIde(be, root);
  expect(title).toHaveBeenCalledWith(`Project1 - VibeBasic ${__APP_VERSION__} [design]`);
  // a new project has no components checked: Pointer and the 18 intrinsic controls only, as in VB6
  expect(root.querySelectorAll('.tbx98-btn').length).toBe(20);
  expect(root.querySelectorAll('.tb98-tool').length).toBe(19);   // with the Menu Editor
  expect(root.querySelector('.ide98-mdi .vb-form')).not.toBeNull();
  expect(root.querySelector('.ide98-mdi .mdi98 > .title-bar .title-bar-text')!.textContent).toBe('Project1 - Form1 (Form)');
  expect(ide.layout.isPaneVisible('immediate')).toBe(false);
  ide.actions.viewImmediate();
  expect(ide.layout.isPaneVisible('immediate')).toBe(true);
  (root.querySelector('[data-tool="Label"]') as HTMLElement).click();
  expect(ide.state.currentTool).toBe('Label');
  expect((root.querySelector('[data-tool="Label"]') as HTMLElement).title).toBe('Label');
  (root.querySelector('[data-tool="Pointer"]') as HTMLElement).click();
  expect(ide.state.currentTool).toBe('Pointer');
});

test('Debug menu items are enabled per mode', () => {
  const s = new IdeState();
  const names = ['stepInto', 'stepOver', 'stepOut', 'runToCursor', 'toggleBreakpoint', 'clearAllBreakpoints'];
  const items = buildMenus(Object.fromEntries(names.map(n => [n, () => {}])), s).find(m => m.label === 'Debug')!.items.filter(i => !i.separator);
  const enabled = () => items.filter(i => i.enabled!()).map(i => i.label);
  expect(enabled()).toEqual(['Step Into', 'Step Over']);
  s.activeView = { kind: 'code', itemId: s.project.forms[0].id };
  expect(enabled()).toEqual(['Step Into', 'Step Over', 'Run To Cursor', 'Toggle Breakpoint']);
  s.breakpointsChanged(true);
  s.mode = 'run';
  expect(enabled()).toEqual(['Toggle Breakpoint', 'Clear All Breakpoints']);
  s.mode = 'break';
  expect(enabled()).toEqual(['Step Into', 'Step Over', 'Step Out', 'Run To Cursor', 'Toggle Breakpoint', 'Clear All Breakpoints']);
});

test('Format items are greyed out unless they can work: design mode, a designer, enough selected controls (review08 #14)', () => {
  const s = new IdeState();
  const f = s.project.forms[0];
  f.controls.push({ id: 'a', type: 'Label', name: 'Label1', index: null, parentId: null, props: {} },
    { id: 'b', type: 'Label', name: 'Label2', index: null, parentId: null, props: {} });
  const noop = () => {};
  const acts = { alignLefts: noop, sameBoth: noop, bringToFront: noop, lockControls: noop };
  const format = buildMenus(acts, s).find(m => m.label === 'Format')!.items;
  const item = (subLabel: string | null, label: string) =>
    (subLabel ? (format.find(i => i.label === subLabel)!.submenu as MenuItem[]) : format).find(i => i.label === label)!;
  const state = () => [item('Align', 'Lefts'), item('Make Same Size', 'Both'), item('Order', 'Bring to Front'), item(null, 'Lock Controls')]
    .map(i => i.enabled!());
  expect(state()).toEqual([false, false, false, false]);        // no designer active
  s.setActiveView({ kind: 'designer', formId: f.id });
  s.setSelection({ formId: f.id, ids: [] });
  expect(state()).toEqual([false, false, false, true]);
  s.setSelection({ formId: f.id, ids: ['a'] });
  expect(state()).toEqual([false, false, true, true]);
  s.setSelection({ formId: f.id, ids: ['a', 'b'] });
  expect(state()).toEqual([true, true, true, true]);
  s.setMode('run');
  expect(state()).toEqual([false, false, false, false]);
  s.setMode('design');
  s.setActiveView({ kind: 'code', itemId: f.id });
  expect(state()).toEqual([false, false, false, false]);
});
