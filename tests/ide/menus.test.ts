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
test('shortcuts, submenus and debug items disabled', () => {
  const all = buildMenus({ stepInto: () => {}, toggleBreakpoint: () => {} });
  const debug = all.find(m => m.label === 'Debug')!.items;
  expect(debug.map(i => [i.label, i.shortcut])).toEqual([['Step Into', 'F8'], ['Toggle Breakpoint', 'F9']]);
  expect(debug.every(i => !i.enabled!())).toBe(true);
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
  expect(root.querySelectorAll('.tbx98-btn').length).toBe(15);
  expect(root.querySelectorAll('.tb98-tool').length).toBe(14);
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
