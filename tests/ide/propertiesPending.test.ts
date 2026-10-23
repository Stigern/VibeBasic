// @vitest-environment jsdom
// A value typed in the Properties window but not yet entered (no Enter, no blur: F5, Ctrl+S or a toolbar button keep the focus).
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { createPropertiesWindow, type PropertiesWindow } from '../../src/ide/properties';
import { addControlsCmd } from '../../src/model/commands';
import { newControl } from '../../src/model/controls';
import { messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), messageBox98: vi.fn() }));

let ide: IdeState, host: HTMLElement, win: PropertiesWindow;
const form = () => ide.project.forms[0];
const rowEl = (name: string) => host.querySelector(`.pw98-row[data-prop="${name}"]`) as HTMLElement;
function type(name: string, text: string): HTMLInputElement {
  rowEl(name).click();
  const input = rowEl(name).querySelector('.pw98-editor') as HTMLInputElement;
  input.value = text;   // typed, not entered
  return input;
}

beforeEach(() => {
  vi.mocked(messageBox98).mockReset().mockResolvedValue(1);
  ide = new IdeState();
  host = document.createElement('div');
  document.body.replaceChildren(host);
  win = createPropertiesWindow(host, ide, { backend: { openFileDialog: vi.fn(), readBinaryFile: vi.fn() } as unknown as Backend });
  const d = newControl(form(), 'CommandButton', { left: 0, top: 0 }, null);
  ide.stack.execute(addControlsCmd(form().id, [d]));
  ide.setSelection({ formId: form().id, ids: [d.id] });
});

test('commitPendingEdit (before Run, Save and Make) puts the typed value into the project', () => {
  type('Caption', 'Go');
  expect(win.commitPendingEdit()).toBe(true);
  expect(form().controls[0].props.Caption).toBe('Go');
  expect(win.commitPendingEdit()).toBe(true);   // nothing pending any more
  expect(ide.stack.canUndo).toBe(true);
});

test('an invalid typed value is not committed and stops the caller', () => {
  type('Left', 'abc');
  expect(win.commitPendingEdit()).toBe(false);
  expect(form().controls[0].props.Left).toBe(0);
  expect(messageBox98).toHaveBeenCalled();
});

test('a re-render (the selection or the project changed) commits the typed value instead of dropping it', () => {
  type('Caption', 'Typed');
  win.refresh();
  expect(form().controls[0].props.Caption).toBe('Typed');
});

// review08 #2: the multi-line editor (List, multi-line Text) commits on anything that re-renders the window, not just a click away
describe('multi-line editor', () => {
  let list: ReturnType<typeof newControl>;
  const openList = (text: string): HTMLTextAreaElement => {
    list = newControl(form(), 'ListBox', { left: 2000, top: 0 }, null);
    ide.stack.execute(addControlsCmd(form().id, [list]));
    ide.setSelection({ formId: form().id, ids: [list.id] });
    rowEl('List').click();
    (rowEl('List').querySelector('.pw98-btn') as HTMLElement).click();
    const ta = document.querySelector('.popup98 textarea') as HTMLTextAreaElement;
    ta.value = text;
    return ta;
  };
  const listOf = () => form().controls.find(c => c.id === list.id)!.props.List;

  test('selecting another control in the designer commits the text', () => {
    openList('one\ntwo');
    ide.setSelection({ formId: form().id, ids: [form().controls[0].id] });
    expect(listOf()).toEqual(['one', 'two']);
    expect(document.querySelector('.popup98 textarea')).toBeNull();
  });
  test('Save and Run (commitPendingEdit) commit the text', () => {
    openList('one\ntwo');
    expect(win.commitPendingEdit()).toBe(true);
    expect(listOf()).toEqual(['one', 'two']);
  });
  test('markSaved (its project event re-renders the window) commits the text', () => {
    openList('a');
    ide.stack.markSaved();
    expect(listOf()).toEqual(['a']);
  });
  test('Escape still throws the text away', () => {
    const ta = openList('one');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(listOf()).toEqual([]);
    expect(win.commitPendingEdit()).toBe(true);
    expect(listOf()).toEqual([]);
  });
});
