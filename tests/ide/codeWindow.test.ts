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

test('a command that leaves the code alone neither re-reads nor re-parses the whole doc (perf)', async () => {
  const { Text } = await import('@codemirror/state');
  const { setPropertyCmd } = await import('../../src/model/commands');
  set('Private Sub Command1_Click()\nEnd Sub', 3);
  const caption = (v: string) => ide.stack.execute(setPropertyCmd(form().id, form().controls[0].id, 'Caption', v));
  caption('A');
  const read = vi.spyOn(Text.prototype, 'toString');
  caption('B');
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  // a change of the model's code still reaches the editor
  ide.stack.undo(); ide.stack.undo();
  form().code = 'Dim x\n';
  ide.emit('project');
  expect(cw.getSource()).toBe('Dim x\n');
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
  return [...document.querySelectorAll('.popup98-layer .cb98-item')] as HTMLElement[];
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
  expect([...document.querySelectorAll('.popup98-layer .cb98-item')].map(e => e.textContent))
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

test('member completion opens after a dot (wiring smoke)', async () => {
  addCtl('TextBox'); open();
  set('Text1.Se');
  const { currentCompletions, startCompletion } = await import('@codemirror/autocomplete');
  startCompletion(view);
  await new Promise(r => setTimeout(r, 50));
  expect(currentCompletions(view.state).map(c => c.label)).toEqual(['SelLength', 'SelStart', 'SelText', 'SetFocus']);
});

test('Mod-i in the editor opens Ask AI (not selectParentSyntax)', () => {
  const askAi = vi.fn();
  registerCodeActions(ide, { askAi } as unknown as IdeActions, { mdiHost: host, actions: { askAi } as unknown as IdeActions });
  set('Private Sub Command1_Click()\nEnd Sub', 3);
  const mac = /Mac/.test(navigator.platform);
  const ev = new KeyboardEvent('keydown', { key: 'i', keyCode: 73, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(ev);
  expect(askAi).toHaveBeenCalledTimes(1);
  expect(ev.defaultPrevented).toBe(true);
});

test('right-click menu items per mode', async () => {
  const askAi = vi.fn();
  registerCodeActions(ide, { askAi } as unknown as IdeActions, { mdiHost: host, actions: { askAi } as unknown as IdeActions });
  const labels = () => [...document.querySelectorAll('.menu98 .menu98-item')].map(e => e.classList.contains('sep') ? '-' : e.textContent);
  const menu = () => { document.querySelectorAll('.menu98').forEach(m => m.remove()); view.dom.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); return labels(); };
  expect(menu()).toEqual(['Cut', 'Copy', 'Paste', 'Select All', '-', 'Ask AI...']);
  // Select All + Cut work on the editor
  set('abc');
  (document.querySelectorAll('.menu98 .menu98-item')[3] as HTMLElement).click();
  expect(view.state.selection.main.to - view.state.selection.main.from).toBe(3);
  menu();
  (document.querySelector('.menu98 .menu98-item') as HTMLElement).click();
  await vi.waitFor(() => expect(cw.getSource()).toBe(''));
  ide.setMode('run');
  expect(menu()).toEqual(['Copy', 'Select All']);
  ide.setMode('break');
  expect(menu()).toEqual(['Copy', 'Select All']);
});

test('a breakpoint follows its line when a line is inserted above it', () => {
  set('Private Sub Form_Load()\n  x = 1\n  y = 2\nEnd Sub\n');
  expect(cw.toggleBreakpoint(3)).toBe(true);
  expect(cw.breakpointLines()).toEqual([3]);
  expect(view.dom.querySelectorAll('.cm-vb-bp').length).toBe(1);
  expect(ide.hasBreakpoints).toBe(true);
  view.dispatch({ changes: { from: view.state.doc.line(2).from, insert: '  z = 0\n' } });
  expect(cw.breakpointLines()).toEqual([4]);
  expect(cw.toggleBreakpoint(4)).toBe(true);
  expect(cw.breakpointLines()).toEqual([]);
  expect(ide.hasBreakpoints).toBe(false);
});

test('applying a whole-module AI change keeps the breakpoints of untouched procedures (review 08 final #2)', async () => {
  const { applyCodeProposal } = await import('../../src/ai/codeMode');
  const before = 'Private Sub Form_Load()\n  x = 1\n  y = 2\nEnd Sub\n\nPrivate Sub Helper()\n  w = 0\nEnd Sub\n\nPrivate Sub Command1_Click()\n  z = 3\nEnd Sub\n';
  set(before, 0);
  for (const n of [2, 3, 7, 11]) expect(cw.toggleBreakpoint(n)).toBe(true);
  // the AI answer changes Form_Load's y line and Command1_Click; Helper, between them, is untouched
  const proposal = 'Private Sub Form_Load()\r\n  x = 1\r\n  y = 20\r\nEnd Sub\r\nPrivate Sub Command1_Click()\r\n  MsgBox "a"\r\n  z = 4\r\nEnd Sub';
  const applied = applyCodeProposal(cw.getSource(), proposal, 'Command1_Click');
  expect(applied).not.toBeNull();
  cw.applyChange(0, cw.getSource().length, applied!.source);
  expect(cw.getSource()).toBe(applied!.source);
  // x = 1 and w = 0 are untouched and y = 2 was edited in place: they keep theirs; z = 3 was replaced by two lines
  expect(cw.breakpointLines()).toEqual([2, 3, 7]);
  expect(view.state.selection.main.head).toBe(0);
  // a line the change removes as a whole loses its breakpoint
  cw.applyChange(0, cw.getSource().length, cw.getSource().replace('  x = 1\n', ''));
  expect(cw.breakpointLines()).toEqual([2, 6]);
});

test('F9 on a comment, blank, Dim or Sub header line does nothing', () => {
  set("Dim a\nPrivate Sub Form_Load()\n  ' note\n\n  Dim b As Integer\n  b = 1\nEnd Sub\n");
  const actions: IdeActions = {};
  registerCodeActions(ide, actions, { mdiHost: host });
  for (const n of [1, 2, 3, 4, 5, 7]) { toLine(n); actions.toggleBreakpoint(); }
  expect(cw.breakpointLines()).toEqual([]);
  toLine(6); actions.toggleBreakpoint();
  expect(cw.breakpointLines()).toEqual([6]);
});

test('deleting the line of a breakpoint removes the breakpoint instead of moving it (review08 #5)', () => {
  set('Private Sub Form_Load()\n  x = 1\n  y = 2\nEnd Sub\n');
  expect(cw.toggleBreakpoint(2)).toBe(true);
  const l2 = () => view.state.doc.line(2);
  view.dispatch({ changes: { from: l2().from, to: l2().to + 1 } });   // the whole line with its line break
  expect(view.state.doc.line(2).text).toBe('  y = 2');
  expect(cw.breakpointLines()).toEqual([]);
  expect(cw.toggleBreakpoint(2)).toBe(true);
  view.dispatch({ changes: { from: view.state.doc.line(1).to, to: l2().to } });   // from the end of the line above
  expect(cw.breakpointLines()).toEqual([]);
  set('Private Sub Form_Load()\n  x = 1\n  y = 2\nEnd Sub\n');
  expect(cw.toggleBreakpoint(3)).toBe(true);
  view.dispatch({ changes: { from: l2().from + 2, to: l2().to, insert: 'x = 10' } });   // editing another line keeps it
  view.dispatch({ changes: { from: view.state.doc.line(3).from, to: view.state.doc.line(3).to, insert: '  y = 3' } });   // retyped in place
  expect(cw.breakpointLines()).toEqual([3]);
});

test('in break mode neither the event dropdown nor leaving a line changes the code (review08 #12)', () => {
  const code = 'Private Sub Form_Load()\ntext1.text="x"\nx = \nEnd Sub';
  set(code, 'Private Sub Form_Load()\ntext1.text="x"'.length);
  ide.stack.markSaved();
  ide.setMode('break');
  toLine(3);                                   // leaves the unprettified line 2
  toLine(1);                                   // leaves the bad line 3
  cw.gotoProcedure('Command1', 'Click');       // no stub
  expect(cw.getSource()).toBe(code);
  expect(ide.stack.isDirty).toBe(false);
  expect(box).not.toHaveBeenCalled();
  cw.gotoProcedure('Form', 'Load');            // an existing procedure is still shown
  expect(cw.getCursorLine()).toBe(2);
});

test('a class module: (General) / Class in the Object box, Initialize stub, Property procedures in the Procedure box', () => {
  ide.project.modules.push({ id: 'c1', name: 'Class1', kind: 'class', code: 'Public Property Get Count() As Long\nEnd Property\nPublic Property Let Count(v As Long)\nEnd Property' });
  const w = openCodeWindow(ide, 'c1', { mdiHost: host });
  const items = (i: number) => {
    (w.win.el.querySelectorAll('.cb98 .cb98-arrow')[i] as HTMLElement).click();
    const r = [...document.querySelectorAll('.popup98-layer .cb98-item')].map(e => e.textContent);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    return r;
  };
  expect(items(0)).toEqual(['(General)', 'Class']);
  w.gotoLine(1);
  expect(items(1)).toEqual(['(Declarations)', 'Count [PropertyGet]', 'Count [PropertyLet]']);
  w.gotoProcedure('Class', 'Initialize');
  expect(w.getSource()).toMatch(/\n\nPrivate Sub Class_Initialize\(\)\n\nEnd Sub$/);
});
