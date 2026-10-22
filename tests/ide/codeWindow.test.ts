// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { openCodeWindow, registerCodeActions, fixMemberCase, type CodeWindow } from '../../src/ide/codeWindow';
import { IdeState } from '../../src/ide/ideState';
import type { IdeActions } from '../../src/ide/menus';
import { addControlsCmd } from '../../src/model/commands';
import { newControl } from '../../src/model/controls';
import { compileErrorBox } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => ({ ...(await orig<typeof import('../../src/ui98/dialogs')>()), compileErrorBox: vi.fn(async () => {}) }));
const box = vi.mocked(compileErrorBox);
// jsdom has no layout; CodeMirror measures through Range rects
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

let ide: IdeState, host: HTMLElement, cw: CodeWindow, view: EditorView;
const form = () => ide.project.forms[0];
const open = () => { cw = openCodeWindow(ide, form().id, { mdiHost: host }); view = (cw as unknown as { view: EditorView }).view; };
const set = (text: string, cursor = text.length) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } });
const toLine = (n: number) => cw.gotoLine(n);
const addCtl = (type: 'CommandButton' | 'TextBox') => {
  const d = newControl(form(), type, { left: 0, top: 0 }, null);
  ide.stack.execute(addControlsCmd(form().id, [d]));
  return d;
};

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.body.appendChild(document.createElement('div'));
  ide = new IdeState();
  box.mockClear();
  addCtl('CommandButton'); addCtl('TextBox');
  open();
});

test('title and window reuse', () => {
  expect(cw.win.el.textContent).toContain('Project1 - Form1 (Code)');
  expect(openCodeWindow(ide, form().id)).toBe(cw);
});

test('leaving a line prettifies and capitalizes control property', () => {
  set('Private Sub Command1_Click()\ntext1.text="x"\nEnd Sub', 'Private Sub Command1_Click()\ntext1.text="x"'.length);
  toLine(1);
  expect(cw.getSource().split('\n')[1]).toBe('Text1.Text = "x"');
  expect(form().code).toBe(cw.getSource());
  expect(ide.stack.isDirty).toBe(true);
});

test('leaving a bad line marks red and shows compile error', () => {
  set('x = \ny = 1', 4);
  toLine(2);
  expect(box).toHaveBeenCalledTimes(1);
  expect(box.mock.calls[0][1]).toContain('Expected: expression');
  expect(view.dom.querySelector('.cm-line.cm-vb-error')?.textContent).toBe('x =');
  // fixing the line clears the mark
  view.dispatch({ changes: { from: 3, insert: ' 1' }, selection: { anchor: 5 } });
  toLine(2);
  expect(view.dom.querySelector('.cm-vb-error')).toBeNull();
});

test('continuation lines are checked as one logical line', () => {
  set('x = 1 + _\n2\ny = 1', 10);
  toLine(2); toLine(3);
  expect(box).not.toHaveBeenCalled();
});

test('Auto Syntax Check off: no error', () => {
  ide.setOptions({ autoSyntaxCheck: false });
  set('x = \ny = 1', 4);
  toLine(2);
  expect(box).not.toHaveBeenCalled();
});

const procItems = () => {
  const combos = cw.win.el.querySelectorAll('.cb98');
  (combos[1].querySelector('.cb98-arrow') as HTMLElement).click();
  return [...combos[1].querySelectorAll('.cb98-item')] as HTMLElement[];
};

test('procedure dropdown bolds implemented events', () => {
  set('Private Sub Command1_Click()\n\nEnd Sub', 30);
  const objs = cw.win.el.querySelector('.cb98')!;
  expect(objs.querySelector('.cb98-input')).toHaveProperty('value', 'Command1');
  const bold = procItems().filter(i => i.classList.contains('cb98-bold')).map(i => i.textContent);
  expect(bold).toEqual(['Click']);
});

test('gotoProcedure creates a stub once and places the cursor on the empty line', () => {
  set('Option Explicit');
  cw.gotoProcedure('Command1', 'Click');
  expect(cw.getSource()).toBe('Option Explicit\n\nPrivate Sub Command1_Click()\n\nEnd Sub');
  expect(cw.getCursorLine()).toBe(4);
  cw.gotoProcedure('command1', 'click');
  expect(cw.getSource().match(/Command1_Click/g)).toHaveLength(1);
});

test('object dropdown lists (General), Form, controls alphabetically, arrays once', () => {
  addCtl('CommandButton');
  const c = form().controls[form().controls.length - 1];
  c.name = 'Command1'; c.index = 0;
  ide.emit('project');
  (cw.win.el.querySelector('.cb98 .cb98-arrow') as HTMLElement).click();
  expect([...cw.win.el.querySelectorAll('.cb98')[0].querySelectorAll('.cb98-item')].map(e => e.textContent))
    .toEqual(['(General)', 'Form', 'Command1', 'Text1']);
});

test('external change reloads the document; line errors and break line', () => {
  form().code = 'a = 1\nb = 2';
  ide.emit('project');
  expect(cw.getSource()).toBe('a = 1\nb = 2');
  cw.markErrorLines([2]);
  expect(view.dom.querySelectorAll('.cm-vb-error')).toHaveLength(1);
  cw.setBreakLine(1);
  expect(view.dom.querySelector('.cm-vb-break')?.textContent).toBe('a = 1');
  cw.setBreakLine(null);
  expect(view.dom.querySelector('.cm-vb-break')).toBeNull();
});

test('keywords coloured, builtins not; applyChange edits', () => {
  set('If x Then MsgBox "a" \' note');
  const kw = [...view.dom.querySelectorAll('.cm-vb-kw')].map(e => e.textContent);
  expect(kw).toEqual(['If', 'Then']);
  expect(view.dom.querySelector('.cm-vb-comment')?.textContent).toBe("' note");
  cw.applyChange(0, 2, 'while');
  expect(cw.getSource().startsWith('while x')).toBe(true);
});

test('viewCode action', () => {
  const actions: IdeActions = {};
  registerCodeActions(ide, actions, { mdiHost: host });
  actions.viewCode(form().id, 'Command1', 'Click');
  expect(form().code).toContain('Private Sub Command1_Click()');
  expect(ide.activeView).toEqual({ kind: 'code', itemId: form().id });
});

test('fixMemberCase uses registry for Me. and control types', () => {
  const cs = [{ name: 'Text1', type: 'TextBox' as const }];
  expect(fixMemberCase('Me.caption = text1.text', 'Form1', cs)).toBe('Me.Caption = text1.Text');
  expect(fixMemberCase('Me.text1.setfocus', 'Form1', cs)).toBe('Me.Text1.SetFocus');
});

const listenerCount = () => ((ide as unknown as { listeners: Record<string, unknown[]> }).listeners.project ?? []).length;

test('closing unsubscribes the project listener; reopening registers one', () => {
  const base = listenerCount() - 1;   // this window's listener
  cw.win.close();
  expect(listenerCount()).toBe(base);
  expect(() => ide.emit('project')).not.toThrow();
  open();
  expect(listenerCount()).toBe(base + 1);
});

test('undo / redo go to the editor when a code window is active, else to the command stack', () => {
  const actions: IdeActions = { undo: () => ide.stack.undo(), redo: () => ide.stack.redo() };
  registerCodeActions(ide, actions, { mdiHost: host });
  const n = form().controls.length;
  set('abc');
  ide.setActiveView({ kind: 'code', itemId: form().id });
  actions.undo();
  expect(cw.getSource()).toBe('');
  actions.redo();
  expect(cw.getSource()).toBe('abc');
  expect(form().controls).toHaveLength(n);
  ide.setActiveView({ kind: 'designer', formId: form().id });
  actions.undo();   // command stack: removes the last added control
  expect(form().controls).toHaveLength(n - 1);
});

test('fixMemberCase keeps the owner across an index', () => {
  const cs = [{ name: 'Text1', type: 'TextBox' as const }];
  expect(fixMemberCase('Text1(0).text = "a"', 'Form1', cs)).toBe('Text1(0).Text = "a"');
  expect(fixMemberCase('Me.text1(i + 1).text = ""', 'Form1', cs)).toBe('Me.Text1(i + 1).Text = ""');
});
