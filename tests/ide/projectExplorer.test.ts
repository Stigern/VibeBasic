// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { IdeState } from '../../src/ide/ideState';
import { addForm, addModule, createProjectExplorer, removeItem } from '../../src/ide/projectExplorer';
import { createPropertiesWindow } from '../../src/ide/properties';
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

test('project properties: Startup Object Sub Main and the Make tab fields, one undo step', async () => {
  const p = showProjectProperties(ide);
  const row = (label: string) => [...document.querySelectorAll<HTMLElement>('.dlg98 .dlgform98-row')].find(r => r.firstElementChild?.textContent === label)!;
  const set = (label: string, v: string, i = 0) => { const el = row(label).querySelectorAll('input')[i]; el.value = v; el.dispatchEvent(new Event('change')); };
  set('Startup Object:', 'Sub Main');
  [...document.querySelectorAll<HTMLElement>('.dlg98 .tabs98-tab')].find(t => t.textContent === 'Make')!.click();
  set('Version Number:', '2', 0);
  set('Version Number:', '5', 2);
  set('Version Information:', 'Company Name');
  const value = row('Value:').querySelector('input')!;
  value.value = 'Acme'; value.dispatchEvent(new Event('input'));
  set('File Types:', '*.kalk, TXT');
  set('Command Line Arguments:', '/x a.txt');
  set('Conditional Compilation Arguments:', 'BETA = 1');
  press('OK');
  await p;
  expect(ide.project).toMatchObject({
    subMain: true, startupForm: 'Form1', fileTypes: ['kalk', 'txt'], commandLine: '/x a.txt', condComp: 'BETA = 1',
    versionInfo: { major: 2, minor: 0, revision: 5, companyName: 'Acme' },
  });
  ide.stack.undo();
  expect(ide.project.subMain ?? ide.project.versionInfo ?? ide.project.commandLine ?? ide.project.fileTypes).toBeUndefined();
});

test('project properties: OK with nothing changed adds no undo step, whatever the key order of versionInfo', async () => {
  ide.project.versionInfo = { companyName: 'Acme', revision: 3, minor: 2, major: 1, autoIncrement: false };
  const p = showProjectProperties(ide);
  press('OK');
  await p;
  expect(ide.stack.canUndo).toBe(false);
  expect(ide.stack.isDirty).toBe(false);
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
  [...document.querySelectorAll<HTMLElement>('.tabs98-tab')].find(t => t.textContent === 'General')!.click();
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

test('a module selected in the Project Explorer shows its (Name) in the Properties window and can be renamed (review08 #3)', async () => {
  const props = document.createElement('div');
  document.body.append(props);
  createProjectExplorer(host, ide);
  createPropertiesWindow(props, ide);
  addModule(ide);
  const m = ide.project.modules[0];
  ide.setSelection({ formId: ide.project.forms[0].id, ids: [] });
  expect(props.querySelector('.cb98-input')).toHaveProperty('value', 'Form1 Form');
  (host.querySelector(`.pe98-row[data-id="${m.id}"]`) as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  const nameRow = () => props.querySelector('.pw98-row[data-prop="(Name)"]') as HTMLElement;
  expect(props.querySelector('.cb98-input')).toHaveProperty('value', 'Module1 Module');
  expect([...props.querySelectorAll('.pw98-row')].map(r => (r as HTMLElement).dataset.prop)).toEqual(['(Name)']);
  const enter = (text: string) => {
    nameRow().click();
    const input = nameRow().querySelector('.pw98-editor') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  enter('modMath');
  expect(m.name).toBe('modMath');
  expect(props.querySelector('.cb98-input')).toHaveProperty('value', 'modMath Module');
  enter('Form1');                     // clashes with the form
  await flush();
  expect(m.name).toBe('modMath');
  expect(box).toHaveBeenCalled();
  ide.stack.undo();
  expect(m.name).toBe('Module1');
  ide.setSelection({ formId: ide.project.forms[0].id, ids: [] });   // a form selection shows the form again
  expect(props.querySelector('.cb98-input')).toHaveProperty('value', 'Form1 Form');
});

test('Add Class Module makes Class1 (Instancing 1) in a Class Modules folder; the Properties window shows Instancing', () => {
  createProjectExplorer(host, ide);
  addModule(ide, undefined, 'class');
  expect(ide.project.modules[0]).toMatchObject({ name: 'Class1', kind: 'class', instancing: 1 });
  expect(labels().slice(-2)).toEqual(['Class Modules', 'Class1 (Class1)']);
  const props = document.createElement('div');
  document.body.appendChild(props);
  createPropertiesWindow(props, ide);
  ide.explorerItemId = ide.project.modules[0].id;
  ide.setSelection(null);
  expect([...props.querySelectorAll('.pw98-row')].map(r => r.textContent)).toEqual(['(Name)Class1', 'Instancing1 - Private']);
});
