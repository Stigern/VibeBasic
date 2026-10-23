// @vitest-environment jsdom
// Tools > Menu Editor, menus in the project file and the designer's menu bar.
import { beforeEach, expect, test, vi } from 'vitest';
import { openDesigner } from '../../src/ide/designer';
import { IdeState } from '../../src/ide/ideState';
import { showMenuEditor } from '../../src/ide/menuEditor';
import { menuTree } from '../../src/model/menus';
import { parseProject, serializeProject } from '../../src/model/serialize';
import type { MenuNode } from '../../src/model/menus';
import { messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), messageBox98: vi.fn(async () => 1) }));
const box = vi.mocked(messageBox98);

let ide: IdeState;
const form = () => ide.project.forms[0];
const flush = () => new Promise(r => setTimeout(r, 0));
const dlg = () => document.querySelector('.dlg98') as HTMLElement;
const btn = (label: string) => [...dlg().querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement;
const text = (i: number) => dlg().querySelectorAll<HTMLInputElement>('.me98 input[type=text]')[i];
const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const shape = (nodes: MenuNode[]): unknown[] => nodes.map(n => [n.def.name, n.def.props.Caption, n.def.props.Shortcut, ...(n.children.length ? [shape(n.children)] : [])]);

/** One line: Caption, Name; then Next. `indent` presses → first. */
function line(caption: string, name: string, indent = false, shortcut?: string): void {
  if (indent) btn('→').click();
  type(text(0), caption);
  type(text(1), name);
  if (shortcut) {
    const input = dlg().querySelectorAll<HTMLInputElement>('.me98 .cb98-input')[0];
    input.value = shortcut;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  btn('Next').click();
}

beforeEach(() => {
  ide = new IdeState();
  document.body.replaceChildren();
});

test('the Menu Editor builds File (&Open Ctrl+O, -, E&xit) and Edit in one undo step; the project file keeps them', async () => {
  const done = showMenuEditor(ide, form().id, document);
  line('&File', 'mnuFile');
  line('&Open...', 'mnuOpen', true, 'Ctrl+O');
  line('-', 'mnuSep1');
  line('E&xit', 'mnuExit');
  btn('←').click();
  line('&Edit', 'mnuEdit');
  line('&Copy', 'mnuCopy', true);
  expect([...dlg().querySelectorAll('.me98-row .me98-cap')].map(r => r.textContent))
    .toEqual(['&File', '····&Open...', '····-', '····E&xit', '&Edit', '····&Copy', '····']);
  btn('OK').click();
  expect(await done).toBe(true);
  const expected = [['mnuFile', '&File', 0, [['mnuOpen', '&Open...', 15], ['mnuSep1', '-', 0], ['mnuExit', 'E&xit', 0]]],
    ['mnuEdit', '&Edit', 0, [['mnuCopy', '&Copy', 0]]]];
  expect(shape(menuTree(form().controls))).toEqual(expected);
  expect(shape(menuTree(parseProject(serializeProject(ide.project)).forms[0].controls))).toEqual(expected);
  ide.stack.undo();
  expect(form().controls).toEqual([]);
});

test('OK checks the names: a duplicate needs an Index', async () => {
  const done = showMenuEditor(ide, form().id, document);
  line('&File', 'mnuFile');
  line('&Edit', 'mnuFile');
  btn('OK').click(); await flush();
  expect(box).toHaveBeenCalledTimes(1);
  expect(String(box.mock.calls[0][1].prompt)).toContain('must have an index');
  btn('Cancel').click();
  expect(await done).toBe(false);
  expect(form().controls).toEqual([]);
});

test('the designer shows the menu bar under the title bar; the client area is lower; an item opens its Click code', async () => {
  const done = showMenuEditor(ide, form().id, document);
  line('&File', 'mnuFile');
  line('E&xit', 'mnuExit', true);
  btn('OK').click(); await done;
  const host = document.body.appendChild(document.createElement('div'));
  const viewCode = vi.fn();
  openDesigner(ide, form().id, { mdiHost: host, actions: { viewCode } });
  const bar = host.querySelector('.vb-form > .vb-menubar') as HTMLElement;
  expect([...bar.querySelectorAll('.vb-menubar-top')].map(t => t.textContent)).toEqual(['File']);
  expect(bar.previousElementSibling!.classList.contains('title-bar')).toBe(true);
  expect((host.querySelector('.vb-form-client') as HTMLElement).style.height).toBe('195px');   // 214 - 19
  bar.querySelector('.vb-menubar-top')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  const exit = document.querySelector('.vb-menudrop .menu98-item') as HTMLElement;
  expect(exit.textContent).toContain('Exit');
  exit.click();
  expect(viewCode).toHaveBeenCalledWith(form().id, 'mnuExit', 'Click');
});
