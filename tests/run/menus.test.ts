// @vitest-environment jsdom
// Menus at run time: the form window's menu bar, Shortcut keys, Checked from code, menu control arrays and PopupMenu.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlDef, FormDef, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

let container: HTMLElement;
let out: string[];
let session: RunSession | undefined;
beforeEach(() => { container = document.body.appendChild(document.createElement('div')); out = []; });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

function menu(f: FormDef, name: string, caption: string, parent: ControlDef | null, props: Record<string, PropValue> = {}, index: number | null = null): ControlDef {
  const c = newControl(f, 'Menu', { left: 0, top: 0 }, parent?.id ?? null);
  Object.assign(c, { name, index });
  Object.assign(c.props, { Caption: caption, ...props });
  f.controls.push(c);
  return c;
}
/** File (&Open Ctrl+O, -, E&xit) and Edit (&Word Wrap) plus a hidden context menu with one item. */
function project(code: string, extra?: (f: FormDef) => void): Project {
  const p = newProject();
  const f = p.forms[0] = newForm('Form1', code);
  const cmd = newControl(f, 'CommandButton', { left: 120, top: 120 }, null);
  cmd.name = 'Command1';
  f.controls.push(cmd);
  const file = menu(f, 'mnuFile', '&File', null);
  menu(f, 'mnuOpen', '&Open...', file, { Shortcut: 15 });   // Ctrl+O
  menu(f, 'mnuSep', '-', file);
  menu(f, 'mnuExit', 'E&xit', file);
  const edit = menu(f, 'mnuEdit', '&Edit', null);
  menu(f, 'mnuWrap', '&Word Wrap', edit);
  const ctx = menu(f, 'mnuCtx', 'Context', null, { Visible: false });
  menu(f, 'mnuCtxA', 'Alpha', ctx);
  extra?.(f);
  return p;
}
async function start(p: Project): Promise<RunSession> {
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {}, readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  await settle();
  return session;
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(): Promise<void> { for (let i = 0; i < 30; i++) await tick(); }
const formEl = () => container.querySelector<HTMLElement>('.vb-form')!;
const top = (caption: string) => [...formEl().querySelectorAll<HTMLElement>('.vb-menubar-top')].find(t => t.textContent === caption)!;
const items = () => [...document.querySelectorAll<HTMLElement>('.vb-menudrop .menu98-item:not(.sep)')];
const item = (caption: string) => items().find(i => i.querySelector('.menu98-label')!.textContent === caption)!;
const press = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

test('the form window shows the menu bar; clicking Exit raises mnuExit_Click', async () => {
  await start(project('Private Sub mnuExit_Click()\n    Debug.Print "exit"\nEnd Sub\n'));
  expect([...formEl().querySelectorAll('.vb-menubar-top')].map(t => t.textContent)).toEqual(['File', 'Edit']);   // mnuCtx is hidden
  press(top('File')); await settle();
  expect(items().map(i => i.querySelector('.menu98-label')!.textContent)).toEqual(['Open...', 'Exit']);
  expect(item('Open...').querySelector('.menu98-shortcut')!.textContent).toBe('Ctrl+O');
  expect(document.querySelectorAll('.vb-menudrop .sep')).toHaveLength(1);
  click(item('Exit')); await settle();
  expect(out).toEqual(['exit']);
  expect(document.querySelector('.vb-menudrop')).toBeNull();
});

test('the Ctrl+O shortcut raises mnuOpen_Click', async () => {
  await start(project('Private Sub mnuOpen_Click()\n    Debug.Print "open"\nEnd Sub\n'));
  formEl().querySelector<HTMLElement>('[data-control-id] button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, bubbles: true }));
  await settle();
  expect(out).toEqual(['open']);
});

test('Checked set by code shows a checkmark; the menu\'s own Click runs before it opens', async () => {
  await start(project('Private Sub mnuEdit_Click()\n    Debug.Print "edit"\n    mnuWrap.Checked = Not mnuWrap.Checked\nEnd Sub\n'
    + 'Private Sub Command1_Click()\n    mnuWrap.Checked = False\nEnd Sub\n'));
  press(top('Edit')); await settle();
  expect(out).toEqual(['edit']);
  expect(item('Word Wrap').querySelector('.menu98-check')!.textContent).toBe('✓');
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // outside: closes
  expect(document.querySelector('.vb-menudrop')).toBeNull();
  click(formEl().querySelector<HTMLElement>('[data-control-id] button')!); await settle();
  press(top('Edit')); await settle();
  expect(item('Word Wrap').querySelector('.menu98-check')!.textContent).toBe('✓');   // False, then the Click made it True again
});

test('Load of a menu control array element adds an item; its Click gets the Index', async () => {
  const p = project('Private Sub Command1_Click()\n    Load mnuMRU(1)\n    mnuMRU(1).Caption = "second.txt"\nEnd Sub\n'
    + 'Private Sub mnuMRU_Click(Index As Integer)\n    Debug.Print "mru"; Index\nEnd Sub\n', f => {
    const file = f.controls.find(c => c.name === 'mnuFile')!;
    const mru = menu(f, 'mnuMRU', 'first.txt', file, {}, 0);
    f.controls.splice(f.controls.indexOf(mru), 1);
    f.controls.splice(f.controls.findIndex(c => c.name === 'mnuExit'), 0, mru);   // before Exit
  });
  await start(p);
  click(formEl().querySelector<HTMLElement>('[data-control-id] button')!); await settle();
  press(top('File')); await settle();
  expect(items().map(i => i.querySelector('.menu98-label')!.textContent)).toEqual(['Open...', 'first.txt', 'second.txt', 'Exit']);
  click(item('second.txt')); await settle();
  expect(out).toEqual(['mru 1 ']);
});

test('PopupMenu shows a hidden menu\'s items and returns after the chosen item\'s Click', async () => {
  await start(project('Private Sub Form_MouseUp(Button As Integer, Shift As Integer, X As Single, Y As Single)\n    PopupMenu mnuCtx\n    Debug.Print "after"\nEnd Sub\n'
    + 'Private Sub mnuCtxA_Click()\n    Debug.Print "alpha"\nEnd Sub\n'));
  formEl().querySelector('.vb-form-client')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
  formEl().querySelector('.vb-form-client')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));
  await settle();
  expect(items().map(i => i.querySelector('.menu98-label')!.textContent)).toEqual(['Alpha']);
  expect(out).toEqual([]);   // PopupMenu waits
  click(item('Alpha')); await settle();
  expect(out).toEqual(['alpha', 'after']);
});

test('keyboard: Alt+letter opens a menu, arrows skip the separator, Enter chooses; F10 selects the bar, Esc leaves it', async () => {
  await start(project('Private Sub mnuOpen_Click()\n    Debug.Print "open"\nEnd Sub\nPrivate Sub mnuExit_Click()\n    Debug.Print "exit"\nEnd Sub\n'));
  const btn = formEl().querySelector<HTMLElement>('[data-control-id] button')!;
  const key = (key: string, init: KeyboardEventInit = {}) => btn.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  key('f', { code: 'KeyF', altKey: true }); await settle();
  expect(document.querySelector('.vb-menudrop .menu98-item.hot')!.textContent).toContain('Open...');
  key('Enter'); await settle();
  key('ƒ', { code: 'KeyF', altKey: true }); await settle();   // Option+F on a Mac
  key('ArrowDown'); key('Enter'); await settle();
  expect(out).toEqual(['open', 'exit']);
  key('F10');
  expect(top('File').classList.contains('hot')).toBe(true);
  key('ArrowRight');
  expect(top('Edit').classList.contains('hot')).toBe(true);
  key('Escape');
  expect(formEl().querySelector('.vb-menubar-top.hot')).toBeNull();
});
