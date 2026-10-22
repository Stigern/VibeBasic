// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { createPropertiesWindow } from '../../src/ide/properties';
import { addControlsCmd } from '../../src/model/commands';
import { newControl } from '../../src/model/controls';
import type { ControlDef, ControlType } from '../../src/model/types';

let ide: IdeState, host: HTMLElement;
let backend: Pick<Backend, 'openFileDialog' | 'readBinaryFile'>;
const form = () => ide.project.forms[0];
const flush = () => new Promise(r => setTimeout(r, 0));
function add(type: Exclude<ControlType, 'Form'>, name?: string): ControlDef {
  const d = newControl(form(), type, { left: 0, top: 0 }, null);
  if (name) d.name = name;
  ide.stack.execute(addControlsCmd(form().id, [d]));
  return d;
}
const rowEl = (name: string) => host.querySelector(`.pw98-row[data-prop="${name}"]`) as HTMLElement;

beforeEach(() => {
  ide = new IdeState();
  host = document.createElement('div');
  document.body.replaceChildren(host);
  backend = { openFileDialog: vi.fn(), readBinaryFile: vi.fn() };
  createPropertiesWindow(host, ide, { backend: backend as Backend });
});

test('ImageList (Custom)...: pictures are added with the picker, keyed, and stored as assets in one undo step', async () => {
  const il = add('ImageList');
  ide.setSelection({ formId: form().id, ids: [il.id] });
  expect(rowEl('ListImages').textContent).toContain('(Collection)');
  rowEl('ListImages').click();
  const open = rowEl('ListImages').querySelector('button') as HTMLElement;
  expect(open.textContent).toBe('(Custom)...');
  open.click();
  const dlg = () => document.querySelector('.dlg98') as HTMLElement;
  vi.mocked(backend.openFileDialog).mockResolvedValue('/x/a.png');
  vi.mocked(backend.readBinaryFile).mockResolvedValue(new Uint8Array([1, 2, 3]));
  const btn = (label: string) => [...dlg().querySelectorAll('button')].find(b => b.textContent === label) as HTMLElement;
  btn('Insert Picture...').click(); await flush();
  const key = dlg().querySelector('.il98-field') as HTMLInputElement;
  key.value = 'open'; key.dispatchEvent(new Event('input', { bubbles: true }));
  btn('Insert Picture...').click(); await flush();
  expect(dlg().querySelectorAll('.il98-item').length).toBe(2);
  btn('OK').click(); await flush();
  const lines = form().controls[0].props.ListImages as string[];
  expect(lines.length).toBe(2);
  expect(lines[0].startsWith('open|asset-')).toBe(true);
  const asset = lines[0].split('|')[1];
  expect(ide.project.assets[asset]).toEqual({ mime: 'image/png', dataBase64: 'AQID' });
  ide.stack.undo();
  expect(form().controls[0].props.ListImages).toEqual([]);
  expect(ide.project.assets[asset]).toBeUndefined();
});

test('a Toolbar picks its ImageList from a drop-down (shows (None) until one is set)', () => {
  add('ImageList', 'imlIcons');
  const tb = add('Toolbar');
  ide.setSelection({ formId: form().id, ids: [tb.id] });
  rowEl('ImageList').click();
  const input = () => rowEl('ImageList').querySelector('input') as HTMLInputElement;
  expect(input().value).toBe('(None)');
  expect(rowEl('ImageList').querySelector('.cb98')).not.toBeNull();
});
