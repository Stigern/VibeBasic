// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { createPropertiesWindow } from '../../src/ide/properties';
import { formatPropertyValue, parsePropertyInput } from '../../src/ide/propertyEditors';
import { IdeState } from '../../src/ide/ideState';
import { addControlsCmd } from '../../src/model/commands';
import { getPropDef, newControl } from '../../src/model/controls';
import type { ControlDef, ControlType } from '../../src/model/types';
import { messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), messageBox98: vi.fn() }));
const box = vi.mocked(messageBox98);
const def = (name: string, kind: string) => ({ ...getPropDef('CommandButton', name)!, kind } as ReturnType<typeof getPropDef> & object);

let ide: IdeState, host: HTMLElement;
let backend: Pick<Backend, 'openFileDialog' | 'readBinaryFile'>;
const form = () => ide.project.forms[0];
const flush = () => new Promise(r => setTimeout(r, 0));
function add(type: Exclude<ControlType, 'Form'>, l = 0): ControlDef {
  const d = newControl(form(), type, { left: l, top: 0 }, null);
  ide.stack.execute(addControlsCmd(form().id, [d]));
  return d;
}
const rowEl = (name: string) => host.querySelector(`.pw98-row[data-prop="${name}"]`) as HTMLElement;
const rowNames = () => [...host.querySelectorAll('.pw98-row')].map(r => (r as HTMLElement).dataset.prop);
function edit(name: string, text: string) {
  rowEl(name).click();
  const input = rowEl(name).querySelector('.pw98-editor') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

beforeEach(() => {
  box.mockReset();
  box.mockResolvedValue(1);
  ide = new IdeState();
  host = document.createElement('div');
  document.body.replaceChildren(host);
  backend = { openFileDialog: vi.fn(), readBinaryFile: vi.fn() };
  createPropertiesWindow(host, ide, { backend: backend as Backend });
});

test('int parse', () => {
  expect(parsePropertyInput(def('Left', 'int'), '120')).toEqual({ ok: true, value: 120 });
  expect(parsePropertyInput(def('Left', 'int'), 'abc')).toEqual({ ok: false });
});
test('enum parse accepts "2 - Sizable" and "2"', () => {
  const d = getPropDef('Form', 'BorderStyle')!;
  expect(parsePropertyInput(d, '2 - Sizable')).toEqual({ ok: true, value: 2 });
  expect(parsePropertyInput(d, '2')).toEqual({ ok: true, value: 2 });
  expect(parsePropertyInput(d, '9')).toEqual({ ok: false });
});
test('color parse and display', () => {
  const d = getPropDef('CommandButton', 'BackColor')!;
  expect(parsePropertyInput(d, '&H000000FF&')).toEqual({ ok: true, value: 255 });
  expect(parsePropertyInput(d, '&H8000000F&')).toEqual({ ok: true, value: -2147483633 });
  expect(parsePropertyInput(d, '255')).toEqual({ ok: true, value: 255 });
  expect(formatPropertyValue(d, -2147483633)).toBe('&H8000000F&');
});

test('list order: (Name) first then alphabetical', () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  const names = rowNames();
  expect(names[0]).toBe('(Name)');
  expect(names.slice(1)).toEqual([...names.slice(1)].sort((a, b) => a!.localeCompare(b!)));
  expect(names).toContain('Caption');
  expect(names).not.toContain('Value');   // run-time only
});

test('editing Caption changes the project in one undo step', () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  edit('Caption', 'Hello');
  expect(form().controls[0].props.Caption).toBe('Hello');
  ide.stack.undo();
  expect(form().controls[0].props.Caption).toBe('Command1');
});

test('invalid name shows message and reverts', async () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  edit('(Name)', '1abc');
  await flush();
  expect(box).toHaveBeenCalledWith(document, expect.objectContaining({ prompt: 'Invalid property value', buttons: 48 }));
  expect(form().controls[0].name).toBe('Command1');
});

test('duplicate name asks for control array; No keeps the name, Yes makes an array', async () => {
  const a = add('CommandButton'), b = add('CommandButton', 2000);
  ide.setSelection({ formId: form().id, ids: [b.id] });
  box.mockResolvedValue(7);
  edit('(Name)', 'Command1');
  await flush();
  expect(box).toHaveBeenCalledWith(document, expect.objectContaining({
    prompt: "You already have a control named 'Command1'. Do you want to create a control array?" }));
  expect(form().controls[1].name).toBe('Command2');
  box.mockResolvedValue(6);
  edit('(Name)', 'Command1');
  await flush();
  expect([form().controls[0].index, form().controls[1].index]).toEqual([0, 1]);
  expect(form().controls[1].name).toBe('Command1');
  ide.stack.undo();
  expect([a.index, form().controls[0].index, form().controls[1].name]).toEqual([null, null, 'Command2']);
});

test('form name edit renames the form; duplicate form is invalid', async () => {
  ide.setSelection({ formId: form().id, ids: [] });
  edit('(Name)', 'frmMain');
  await flush();
  expect(form().name).toBe('frmMain');
  expect(ide.project.startupForm).toBe('frmMain');
  edit('(Name)', 'frmMain2');
  await flush();
  expect(form().name).toBe('frmMain2');
  // same name again: editor closes, nothing changes
  edit('(Name)', 'frmMain2');
  await flush();
  expect(box).not.toHaveBeenCalled();
  expect(rowEl('(Name)').querySelector('.pw98-editor')).not.toBeNull();   // re-rendered, still editable
  ide.project.forms.push({ id: 'f2', name: 'Other', props: {}, controls: [], code: '' });
  ide.project.modules.push({ id: 'm1', name: 'Mod1', code: '' });
  for (const clash of ['other', 'Mod1']) {
    box.mockClear();
    edit('(Name)', clash);
    await flush();
    expect(box).toHaveBeenCalledWith(document, expect.objectContaining({ prompt: 'Invalid property value', buttons: 48 }));
    expect(form().name).toBe('frmMain2');
  }
});

test('multi-selection: common props only, no (Name), edit applies to all', () => {
  const a = add('CommandButton'), b = add('CommandButton', 2000), t = add('TextBox', 4000);
  ide.setSelection({ formId: form().id, ids: [a.id, b.id, t.id] });
  expect(rowNames()).not.toContain('(Name)');
  expect(rowNames()).not.toContain('Caption');   // TextBox has none
  expect(rowNames()).toContain('Left');
  edit('Top', '300');
  expect(form().controls.map(c => c.props.Top)).toEqual([300, 300, 300]);
  ide.stack.undo();
  expect(form().controls.map(c => c.props.Top)).toEqual([0, 0, 0]);
});

test('multi-selection with differing values opens a blank editor', () => {
  const a = add('CommandButton'), b = add('CommandButton', 2000);
  ide.setSelection({ formId: form().id, ids: [a.id, b.id] });
  rowEl('Left').click();
  expect((rowEl('Left').querySelector('.pw98-editor') as HTMLInputElement).value).toBe('');
});

test('picture: file goes to assets and property set is one undo step; Delete clears', async () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  vi.mocked(backend.openFileDialog).mockResolvedValue('/x/a.png');
  vi.mocked(backend.readBinaryFile).mockResolvedValue(new Uint8Array([1, 2, 3]));
  rowEl('Picture').click();
  (rowEl('Picture').querySelector('.pw98-btn') as HTMLElement).click();
  await flush();
  const ref = form().controls[0].props.Picture as { asset: string };
  expect(ide.project.assets[ref.asset]).toEqual({ mime: 'image/png', dataBase64: 'AQID' });
  expect(rowEl('Picture').textContent).toContain('(Bitmap)');
  const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
  const seen = vi.fn(); document.addEventListener('keydown', seen);
  rowEl('Picture').dispatchEvent(del);
  document.removeEventListener('keydown', seen);
  expect(del.defaultPrevented).toBe(true);   // consumed: global shortcuts ignore it
  expect(seen).not.toHaveBeenCalled();       // and it does not bubble to the document
  await flush();
  expect(form().controls[0].props.Picture).toBeNull();
  ide.stack.undo(); ide.stack.undo();
  expect(ide.project.assets[ref.asset]).toBeUndefined();
});

test('object list labels use control-array notation', () => {
  const a = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [a.id] });
  form().controls[0].index = 0;
  ide.emit('project');
  expect(host.querySelector('.cb98-input')).toHaveProperty('value', 'Command1(0) CommandButton');
});
