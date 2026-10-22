// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { createPropertiesWindow } from '../../src/ide/properties';
import { formatPropertyValue, parsePropertyInput, showFontDialog } from '../../src/ide/propertyEditors';
import { PALETTE_48 } from '../../src/model/colors';
import { IdeState } from '../../src/ide/ideState';
import { addControlsCmd } from '../../src/model/commands';
import { CONTROL_TYPES, getPropDef, newControl, type PropDef } from '../../src/model/controls';
import type { ControlDef, ControlType, PropValue } from '../../src/model/types';
import { messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), messageBox98: vi.fn() }));
vi.mock('../../src/ide/propertyEditors', async orig => ({ ...(await orig<typeof import('../../src/ide/propertyEditors')>()), showFontDialog: vi.fn() }));
const box = vi.mocked(messageBox98);
const fontDlg = vi.mocked(showFontDialog);
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

// ---------------------------------------------------------------------------------------------------------------
// Editors: popups in the body layer, every property of every control type

const layer = () => document.querySelector('.popup98-layer') as HTMLElement;
const items = () => [...document.querySelectorAll<HTMLElement>('.popup98-layer .cb98-item')];
const mousedown = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

test('a property dropdown list renders in the body layer, not inside the value cell', () => {
  ide.setSelection({ formId: form().id, ids: [] });
  rowEl('BorderStyle').click();
  (rowEl('BorderStyle').querySelector('.cb98-arrow') as HTMLElement).click();
  const list = document.querySelector('.cb98-list')!;
  expect(list.closest('.popup98-layer')!.parentElement).toBe(document.body);
  expect(host.querySelector('.pw98-value .cb98-list')).toBeNull();
  expect(items().map(i => i.textContent)).toContain('3 - Fixed Dialog');
  mousedown(items().find(i => i.textContent === '3 - Fixed Dialog')!);
  expect(form().props.BorderStyle).toBe(3);
  expect(document.querySelector('.cb98-list')).toBeNull();
});

const IMAGE_REFS = ['ImageList', 'Icons', 'SmallIcons'];

/** Sets a new value through the row's editor, as a user would; returns the expected stored value. */
async function setThroughEditor(d: PropDef, cur: PropValue, where: string): Promise<unknown> {
  rowEl(d.name).click();
  const btn = () => rowEl(d.name).querySelector('.pw98-btn') as HTMLElement;
  // custom editors (imageListEditor.ts): the ImageList dropdown and the ListImages "(Custom)..." property pages
  if (IMAGE_REFS.includes(d.name)) {
    expect(document.activeElement, where).toBe(rowEl(d.name).querySelector('.cb98-input'));
    (rowEl(d.name).querySelector('.cb98-arrow') as HTMLElement).click();
    expect(items().map(i => i.textContent), where).toEqual(['(None)', 'ImageList1']);
    mousedown(items()[1]);
    return 'ImageList1';
  }
  if (d.name === 'ListImages') {
    expect(btn().textContent, where).toBe('(Custom)...');
    btn().click();
    vi.mocked(backend.openFileDialog).mockResolvedValueOnce('/x/a.png');
    vi.mocked(backend.readBinaryFile).mockResolvedValueOnce(new Uint8Array([1]));
    const dlgBtn = (label: string) => [...document.querySelectorAll<HTMLElement>('.dlg98 button')].find(b => b.textContent === label)!;
    dlgBtn('Insert Picture...').click(); await flush();
    dlgBtn('OK').click(); await flush();
    return [expect.stringMatching(/\|asset-/)];
  }
  switch (d.kind) {
    case 'string': case 'text': case 'int': case 'color': {
      if (d.kind === 'text' && !rowEl(d.name).querySelector('.pw98-editor') && btn()) {
        // always multi-line (RichTextBox): the dropdown edit box
        btn().click();
        const ta = layer().querySelector('textarea')!;
        expect(ta, where).toBeTruthy();
        ta.value = 'a\nb';
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        return 'a\nb';
      }
      expect(rowEl(d.name).querySelector('.pw98-editor'), where).toBeTruthy();
      if (d.kind === 'int') {
        const n = cur as number;
        const v = d.max !== undefined && n + 1 > d.max ? n - 1 : n + 1;
        edit(d.name, String(v));
        return v;
      }
      if (d.kind === 'color') { edit(d.name, '&H000000FF&'); return 255; }
      edit(d.name, 'Zq1');
      return 'Zq1';
    }
    case 'bool': case 'enum': {
      const arrow = rowEl(d.name).querySelector('.cb98-arrow') as HTMLElement;
      expect(arrow, where).toBeTruthy();
      arrow.click();
      const choices = d.kind === 'bool' ? [{ value: true, label: 'True' }, { value: false, label: 'False' }] : d.enumValues!;
      const pick = choices.find(c => c.value !== cur)!;
      expect(items().map(i => i.textContent), where).toEqual(choices.map(c => c.label));
      mousedown(items().find(i => i.textContent === pick.label)!);
      return pick.value;
    }
    case 'font': {
      const f = { name: 'Arial', size: 12, bold: true, italic: false, underline: false };
      fontDlg.mockResolvedValueOnce(f);
      expect(btn(), where).toBeTruthy();
      btn().click();
      await flush();
      return f;
    }
    case 'picture': {
      vi.mocked(backend.openFileDialog).mockResolvedValueOnce('/x/a.png');
      vi.mocked(backend.readBinaryFile).mockResolvedValueOnce(new Uint8Array([1]));
      expect(btn(), where).toBeTruthy();
      btn().click();
      await flush();
      return { asset: expect.stringMatching(/^asset-/) };
    }
    case 'date': {
      expect(rowEl(d.name).querySelector('.pw98-editor'), where).toBeTruthy();
      edit(d.name, '2000-01-15');
      return 36540;
    }
    case 'list': {
      expect(btn(), where).toBeTruthy();
      btn().click();
      const ta = layer().querySelector('textarea')!;
      expect(ta, where).toBeTruthy();
      ta.value = 'a\nb';
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      return ['a', 'b'];
    }
  }
}

test.each(Object.keys(CONTROL_TYPES) as ControlType[])('%s: every design-time property is editable, updates the model, one undo restores', async type => {
  const defs0 = CONTROL_TYPES[type].props.filter(d => d.designTime);
  if (defs0.some(d => IMAGE_REFS.includes(d.name))) add('ImageList', 3000);   // something for its ImageList dropdown
  const id = type === 'Form' ? 'form' : add(type).id;
  ide.setSelection({ formId: form().id, ids: id === 'form' ? [] : [id] });
  const target = () => (id === 'form' ? form() : form().controls.find(c => c.id === id)!);
  const defs = CONTROL_TYPES[type].props.filter(d => d.designTime);
  expect(rowNames()).toEqual(['(Name)', ...defs.map(d => d.name).sort((a, b) => a.localeCompare(b))]);
  for (const d of defs) {
    const where = `${type}.${d.name}`;
    const before = JSON.stringify(target().props);
    const expected = await setThroughEditor(d, target().props[d.name] ?? d.default, where);
    expect(target().props[d.name], where).toEqual(expected);
    ide.stack.undo();
    expect(JSON.stringify(target().props), where).toBe(before);
  }
  // (Name)
  edit('(Name)', 'Zq9');
  await flush();
  expect(target().name).toBe('Zq9');
  ide.stack.undo();
  expect(target().name).not.toBe('Zq9');
});

test('double-clicking a bool row cycles it (one undo step)', () => {
  ide.setSelection({ formId: form().id, ids: [] });
  rowEl('Visible').click();
  rowEl('Visible').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(form().props.Visible).toBe(false);
  rowEl('Visible').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(form().props.Visible).toBe(true);
  ide.stack.undo();
  expect(form().props.Visible).toBe(false);
});

test('colour popup: Palette pick sets the colour; System tab sets &H8000000F&', () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  const open = () => { rowEl('BackColor').click(); (rowEl('BackColor').querySelector('.pw98-btn') as HTMLElement).click(); };
  open();
  const swatches = layer().querySelectorAll<HTMLElement>('.pw98-swatch');
  expect(swatches).toHaveLength(48);
  swatches[5].click();
  expect(form().controls[0].props.BackColor).toBe(PALETTE_48[5]);
  expect(layer().querySelector('.pw98-popup')).toBeNull();
  open();
  [...layer().querySelectorAll<HTMLElement>('.tabs98-tab')].find(t => t.textContent === 'System')!.click();
  [...layer().querySelectorAll<HTMLElement>('.pw98-sysitem')].find(t => t.textContent === 'Button Face')!.click();
  expect(form().controls[0].props.BackColor).toBe(-2147483633);
  expect(rowEl('BackColor').querySelector<HTMLInputElement>('.pw98-editor')!.value).toBe('&H8000000F&');
});

test('object box: "Form1 Form" with the name bold; lists form and controls; choosing one selects it', () => {
  const a = add('CommandButton'), t = add('TextBox', 2000);
  ide.setSelection({ formId: form().id, ids: [] });
  const ob = host.querySelector('.pw98 > .cb98')!;
  expect(ob.querySelector('.cb98-display b')!.textContent).toBe('Form1');
  expect(ob.querySelector('.cb98-display')!.textContent).toBe('Form1 Form');
  (ob.querySelector('.cb98-arrow') as HTMLElement).click();
  expect(items().map(i => i.textContent)).toEqual(['Form1 Form', 'Command1 CommandButton', 'Text1 TextBox']);
  mousedown(items()[2]);
  expect(ide.selection).toEqual({ formId: form().id, ids: [t.id] });
  expect(rowNames()).toContain('MultiLine');
  expect(a).toBeTruthy();
});

test('keyboard: Down/Up move between rows, Ctrl+Shift+letter jumps, invalid int restores the old value', async () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  rowEl('Cancel').click();
  const key = (k: string, o: KeyboardEventInit = {}) =>
    (document.activeElement ?? host).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  host.querySelector<HTMLElement>('.pw98-row.selected .cb98-input')!.focus();
  key('ArrowDown');
  expect(host.querySelector('.pw98-row.selected')!.getAttribute('data-prop')).toBe('Caption');
  expect(host.querySelector('.pw98-desc b')!.textContent).toBe('Caption');
  key('ArrowUp');
  expect(host.querySelector('.pw98-row.selected')!.getAttribute('data-prop')).toBe('Cancel');
  key('W', { ctrlKey: true, shiftKey: true, code: 'KeyW' });
  expect(host.querySelector('.pw98-row.selected')!.getAttribute('data-prop')).toBe('Width');
  edit('Width', 'abc');
  await flush();
  expect(box).toHaveBeenCalledWith(document, expect.objectContaining({ prompt: 'Invalid property value' }));
  expect(rowEl('Width').querySelector<HTMLInputElement>('.pw98-editor')!.value).toBe(String(form().controls[0].props.Width));
});

test('Categorized tab groups rows under VB6 categories (and is remembered)', () => {
  const c = add('CommandButton');
  ide.setSelection({ formId: form().id, ids: [c.id] });
  const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('.tabs98-tab')].find(t => t.textContent === name)!;
  tab('Categorized').click();
  const groups: Record<string, string[]> = {};
  let cur = '';
  for (const el of host.querySelectorAll<HTMLElement>('.pw98-cat, .pw98-row')) {
    if (el.classList.contains('pw98-cat')) groups[cur = el.dataset.cat!] = [];
    else groups[cur].push(el.dataset.prop!);
  }
  expect(Object.keys(groups)).toEqual(['Appearance', 'Behavior', 'Font', 'Misc', 'Position']);
  expect(groups.Position).toEqual(['Height', 'Left', 'Top', 'Width']);
  expect(groups.Misc[0]).toBe('(Name)');
  expect(groups.Font).toEqual(['Font']);
  // a new window opens on the remembered tab
  const host2 = document.createElement('div');
  document.body.appendChild(host2);
  createPropertiesWindow(host2, ide, { backend: backend as Backend });
  expect(host2.querySelector('.tabs98-tab.selected')!.textContent).toBe('Categorized');
  tab('Alphabetic').click();
});
