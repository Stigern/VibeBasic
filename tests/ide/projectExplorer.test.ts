// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { IdeState } from '../../src/ide/ideState';
import { addForm, addModule, createProjectExplorer, removeItem } from '../../src/ide/projectExplorer';
import { showProjectProperties } from '../../src/ide/projectDialogs';
import { showOptions } from '../../src/ide/optionsDialog';
import { BrowserBackend } from '../../src/backend/browserBackend';
import { messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), messageBox98: vi.fn() }));
const box = vi.mocked(messageBox98);

let ide: IdeState, host: HTMLElement;
const flush = () => new Promise(r => setTimeout(r, 0));
const labels = () => [...host.querySelectorAll('.pe98-row')].map(r => r.textContent);
const press = (label: string) => { [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label)!.click(); };
const inputs = () => [...document.querySelectorAll<HTMLInputElement>('.dlg98 input')];

beforeEach(() => {
  box.mockReset(); box.mockResolvedValue(1);
  localStorage.clear();
  ide = new IdeState();
  host = document.createElement('div');
  document.body.replaceChildren(host);
});

test('add form names Form2', () => {
  addForm(ide);
  expect(ide.project.forms[1].name).toBe('Form2');
  expect(ide.project.forms[1].props.Caption).toBe('Form2');
});

test('cannot remove last form', () => {
  const before = JSON.stringify(ide.project);
  removeItem(ide, ide.project.forms[0].id);
  expect(JSON.stringify(ide.project)).toBe(before);
  expect(box).toHaveBeenCalledTimes(1);
  expect(box.mock.calls[0][1].buttons).toBe(48);
});

test('removing startup form moves startup; undo restores', () => {
  addForm(ide);
  removeItem(ide, ide.project.forms[0].id);
  expect(ide.project.startupForm).toBe('Form2');
  expect(ide.project.forms.map(f => f.name)).toEqual(['Form2']);
  ide.stack.undo();
  expect(ide.project.startupForm).toBe('Form1');
  expect(ide.project.forms.map(f => f.name)).toEqual(['Form1', 'Form2']);
});

test('require variable declaration adds Option Explicit to new module', () => {
  addModule(ide);
  expect(ide.project.modules[0].code).toBe('');
  ide.options.requireVariableDeclaration = true;
  addModule(ide);
  expect(ide.project.modules[1].name).toBe('Module2');
  expect(ide.project.modules[1].code.startsWith('Option Explicit')).toBe(true);
});

test('tree labels, folders, toggle and refresh', () => {
  createProjectExplorer(host, ide);
  addModule(ide);
  expect(labels()).toEqual(['Project1 (Project1.vbb)', 'Forms', 'Form1 (Form1)', 'Modules', 'Module1 (Module1)']);
  ide.filePath = '/tmp/My.vbb';
  ide.emit('project');
  expect(labels()[0]).toBe('Project1 (My.vbb)');
  [...host.querySelectorAll<HTMLButtonElement>('.pe98-btn')].find(b => b.textContent === 'Toggle Folders')!.click();
  expect(labels()).toEqual(['Project1 (My.vbb)', 'Form1 (Form1)', 'Module1 (Module1)']);
});

test('selecting a row selects the form; context menu removes it', () => {
  createProjectExplorer(host, ide);
  addForm(ide);
  const row = host.querySelector<HTMLElement>('.pe98-form[data-id]')!;
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(ide.selection?.formId).toBe(ide.project.forms[0].id);
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
  const items = [...document.querySelectorAll('.pe98-menu .menu98-label')].map(i => i.textContent);
  expect(items).toEqual(['View Code', 'View Object', 'Remove Form1']);
  (document.querySelectorAll('.pe98-menu .menu98-item')[2] as HTMLElement).click();
  expect(ide.project.forms.map(f => f.name)).toEqual(['Form2']);
  expect(labels()).toContain('Form2 (Form2)');
});

test('project properties: invalid name rejected, valid change is one undo step', async () => {
  addForm(ide);
  const p = showProjectProperties(ide);
  inputs()[0].value = '1bad';
  press('OK');
  await flush();
  expect(box.mock.calls[0][1]).toMatchObject({ prompt: 'Invalid property value', buttons: 48 });
  expect(document.querySelector('.dlg98')).not.toBeNull();
  inputs()[0].value = 'MyProj';
  inputs()[2].value = 'My App';
  press('OK');
  await p;
  expect(ide.project).toMatchObject({ name: 'MyProj', title: 'My App' });
  ide.stack.undo();
  expect(ide.project).toMatchObject({ name: 'Project1', title: '' });
});

test('options: OK updates ide.options, emits and saves; Cancel changes nothing', async () => {
  const be = new BrowserBackend();
  const onOpt = vi.fn();
  ide.on('options', onOpt);
  let p = showOptions(ide, be);
  press('Cancel');
  await p;
  expect(onOpt).not.toHaveBeenCalled();

  p = showOptions(ide, be);
  const cbs = [...document.querySelectorAll<HTMLInputElement>('.dlg98 input[type=checkbox]')];
  // 98.css draws a check box only as `input + label[for=id]` (a box inside its label is invisible)
  for (const cb of cbs) expect(cb.nextElementSibling?.matches(`label[for="${cb.id}"]`), cb.id).toBe(true);
  cbs[1].checked = true;                       // Require Variable Declaration
  document.querySelectorAll<HTMLElement>('.tabs98-tab')[1].click();   // General tab
  const nums = inputs().filter(i => i.type === 'text');
  nums[0].value = '0';                         // invalid grid width
  press('OK');
  await flush();
  expect(box).toHaveBeenCalledTimes(1);
  expect(ide.options.requireVariableDeclaration).toBe(false);
  nums[0].value = '240';
  press('OK');
  await p;
  expect(ide.options).toMatchObject({ requireVariableDeclaration: true, gridWidth: 240, gridHeight: 120 });
  expect(onOpt).toHaveBeenCalledTimes(1);
  expect(await be.loadSettings<{ gridWidth: number }>('ide')).toMatchObject({ gridWidth: 240 });
});

test('removing a form clears a selection pointing at it', () => {
  addForm(ide);
  const f2 = ide.project.forms[1].id;
  ide.setSelection({ formId: f2, ids: [] });
  removeItem(ide, f2);
  expect(ide.selection).toBeNull();
});
