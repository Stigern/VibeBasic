// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import type { Backend } from '../../src/backend/backend';
import { openCodeWindow, type CodeWindow } from '../../src/ide/codeWindow';
import { createImmediateWindow } from '../../src/ide/immediate';
import { IdeState } from '../../src/ide/ideState';
import { startIde } from '../../src/ide/main';
import { RunController } from '../../src/ide/runController';
import { newControl, newForm, newProject } from '../../src/model/controls';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { compileErrorBox, messageBox98 } from '../../src/ui98/dialogs';

vi.mock('../../src/ui98/dialogs', async orig => {
  const real = await orig<typeof import('../../src/ui98/dialogs')>();
  return { ...real, compileErrorBox: vi.fn(async () => {}), messageBox98: vi.fn(real.messageBox98) };
});
const box = vi.mocked(compileErrorBox);
const msgBox = vi.mocked(messageBox98);
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const tick = () => new Promise(r => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> { for (let i = 0; i < 300 && !cond(); i++) await tick(); }

let ide: IdeState, rc: RunController, container: HTMLElement, immHost: HTMLElement, mdi: HTMLElement;
let wins: Map<string, CodeWindow>;
const imm = () => immHost.querySelector('textarea')!;

function setup(code: string, moduleCode?: string): void {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  const c = newControl(p.forms[0], 'CommandButton', { left: 120, top: 120 }, null);
  c.name = 'Command1';
  p.forms[0].controls.push(c);
  if (moduleCode !== undefined) p.modules.push({ id: 'm1', name: 'Module1', code: moduleCode });
  ide = new IdeState(p);
  document.body.innerHTML = '';
  container = document.body.appendChild(document.createElement('div'));
  immHost = document.body.appendChild(document.createElement('div'));
  mdi = document.body.appendChild(document.createElement('div'));
  wins = new Map();
  const immediate = createImmediateWindow(immHost, () => rc.session, () => ide.project);
  rc = new RunController(ide, () => {
    const h = new InlineFormHost(container);
    h.runtimeErrorBox = async () => 'debug';   // the dialog itself is tested in tests/run/dialogs.test.ts
    return h;
  }, id => {
    const w = openCodeWindow(ide, id, { mdiHost: mdi });
    wins.set(id, w);
    return w;
  }, { immediate, doc: document });
}
const clickButton = () => container.querySelector<HTMLElement>('[data-control-id] button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
function typeLine(text: string): void {
  const ta = imm();
  ta.value += text;
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

beforeEach(() => { box.mockClear(); });
afterEach(async () => { rc?.end(); await tick(); });

test('state machine', async () => {
  setup('');
  await rc.start(false);
  expect(ide.mode).toBe('run');
  rc.breakNow();
  await until(() => ide.mode === 'break');
  expect(ide.mode).toBe('break');
  await rc.start(false);   // F5 continues
  await until(() => ide.mode === 'run');
  expect(ide.mode).toBe('run');
  rc.end();
  expect(ide.mode).toBe('design');
  expect(container.querySelector('.vb-form')).toBeNull();
});

test('runtime error debug opens code at line in yellow', async () => {
  setup('Private Sub Command1_Click()\n    x = 1 / 0\nEnd Sub\n');
  await rc.start(false);
  clickButton();
  await until(() => ide.mode === 'break');
  expect(ide.mode).toBe('break');
  const w = wins.get(ide.project.forms[0].id)!;
  expect(w.win.el.querySelector('.cm-vb-break')?.textContent).toContain('x = 1 / 0');
  expect(immHost.closest('.hidden')).toBeNull();
  rc.end();
  expect(ide.mode).toBe('design');
  expect(w.win.el.querySelector('.cm-vb-break')).toBeNull();
});

test('continue after fixing via immediate', async () => {
  setup('Private Sub Command1_Click()\n    Dim d As Integer\n    Debug.Print 10 / d\nEnd Sub\n');
  await rc.start(false);
  clickButton();
  await until(() => ide.mode === 'break');
  expect(ide.mode).toBe('break');
  typeLine('d = 2');
  await tick(); await tick();
  void rc.start(false);   // F5
  await until(() => ide.mode === 'run');
  await until(() => imm().value.includes('5'));
  expect(imm().value).toContain(' 5 ');
});

test('ctrl+f5 stops on syntax error', async () => {
  setup('', 'Sub Main()\n    x = \nEnd Sub\n');
  await rc.start(true);
  expect(box).toHaveBeenCalledTimes(1);
  expect(ide.mode).toBe('design');
  expect(rc.session).toBeNull();
  const w = wins.get('m1')!;
  expect(w.win.el.querySelector('.cm-vb-error')?.textContent).toContain('x =');
});

function fakeBackend(): Backend & { titles: string[] } {
  const titles: string[] = [];
  return {
    kind: 'browser', titles, setWindowTitle: async (t: string) => { titles.push(t); },
    loadSettings: async () => null, onCloseRequested: () => {}, readBinaryFile: async () => new Uint8Array(),
  } as unknown as Backend & { titles: string[] };
}

test('read-only during run, title follows mode', async () => {
  document.body.innerHTML = '';
  const be = fakeBackend();
  const root = document.body.appendChild(document.createElement('div'));
  const app = startIde(be, root);
  root.querySelector<HTMLElement>('.pw98-row[data-prop="Caption"]')!.click();
  expect(root.querySelector('.pw98-editor')?.hasAttribute('disabled')).toBe(false);
  const cw = openCodeWindow(app.state, app.state.project.forms[0].id);
  const view = (cw as unknown as { view: EditorView }).view;
  expect(view.state.readOnly).toBe(false);
  await app.run.start(false);
  expect(app.state.mode).toBe('run');
  expect(be.titles.at(-1)).toBe(`Project1 - VibeBasic ${__APP_VERSION__} [run]`);
  expect(root.querySelector('.pw98-editor')?.hasAttribute('disabled')).toBe(true);
  expect(view.state.readOnly).toBe(true);
  expect(root.querySelector('.tbx98-grid')?.classList.contains('tbx98-locked')).toBe(true);
  app.run.end();
  expect(be.titles.at(-1)).toBe(`Project1 - VibeBasic ${__APP_VERSION__} [design]`);
  expect(view.state.readOnly).toBe(false);
});

test('a program that ends by itself returns to design', async () => {
  setup('Private Sub Form_Load()\n    Unload Me\nEnd Sub\n');
  await rc.start(false);
  await until(() => ide.mode === 'design');
  expect(ide.mode).toBe('design');
  expect(rc.session).toBeNull();
  expect(container.querySelector('.vb-form')).toBeNull();
});

test('End while a MsgBox is open closes the dialog; End in break leaves no break line', async () => {
  setup('Private Sub Command1_Click()\n    MsgBox "hi"\nEnd Sub\n');
  await rc.start(false);
  clickButton();
  await until(() => !!document.querySelector('.dlg98-overlay'));
  expect(document.querySelector('.dlg98-overlay')).not.toBeNull();
  rc.end();
  expect(ide.mode).toBe('design');
  expect(document.querySelector('.dlg98-overlay')).toBeNull();
});

test('project changes are blocked while running; a second start during the compile box does not stack', async () => {
  setup('', 'Sub Main()\n    x = \nEnd Sub\n');
  let release!: () => void;
  box.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
  const first = rc.start(true);
  await tick();
  void rc.start(true);
  await tick();
  expect(box).toHaveBeenCalledTimes(1);
  release();
  await first;

  document.body.innerHTML = '';
  const be = fakeBackend();
  const root = document.body.appendChild(document.createElement('div'));
  const app = startIde(be, root);
  const forms = app.state.project.forms.length;
  app.actions.addForm?.();
  expect(app.state.project.forms.length).toBe(forms + 1);   // design: works
  await app.run.start(false);
  app.actions.addForm?.(); app.actions.addModule?.(); app.actions.undo?.();
  expect(app.state.project.forms.length).toBe(forms + 1);
  expect(app.state.project.modules.length).toBe(0);
  expect(app.state.stack.canUndo).toBe(true);   // undo did not run
  app.run.end();
});

test('Shift+F5: the new run waits for the previous host teardown', async () => {
  setup('');
  const made: InlineFormHost[] = [];
  let release!: () => void;
  const factory = () => {
    const h = new InlineFormHost(container);
    if (made.length === 0) h.dispose = () => new Promise<void>(r => { release = r; }) as unknown as void;
    made.push(h);
    return h;
  };
  (rc as unknown as { hostFactory: () => InlineFormHost }).hostFactory = factory;
  await rc.start(false);
  expect(made.length).toBe(1);
  const restarted = rc.restart();
  await tick(); await tick();
  expect(made.length).toBe(1);          // still waiting for the old dispose
  release();
  await restarted;
  expect(made.length).toBe(2);
  expect(ide.mode).toBe('run');
});

test('a failing session start shows a critical message box', async () => {
  setup('');
  msgBox.mockClear();
  msgBox.mockImplementationOnce(async () => 1);
  (rc as unknown as { hostFactory: () => InlineFormHost }).hostFactory = () => {
    const h = new InlineFormHost(container);
    h.openForm = async () => { throw new Error('no window'); };
    return h;
  };
  await rc.start(false);
  expect(msgBox).toHaveBeenCalledTimes(1);
  expect(msgBox.mock.calls[0][1]).toMatchObject({ buttons: 16 });
  expect(String(msgBox.mock.calls[0][1].prompt)).toContain('no window');
  expect(ide.mode).toBe('design');
});

test('F8 in design starts and breaks in Form_Load; stepping stays armed for the next event; F9 breaks a click', async () => {
  setup(['Private Sub Form_Load()', '  a = 1', 'End Sub', 'Private Sub Command1_Click()', '  b = 2', '  c = 3', 'End Sub'].join('\n'));
  rc.step('into');
  await until(() => ide.mode === 'break');
  expect(ide.mode).toBe('break');
  const w = wins.get(ide.project.forms[0].id)!;
  expect(w.win.el.querySelector('.cm-line.cm-vb-break')!.textContent).toBe('  a = 1');
  rc.step('over');   // last statement of Form_Load: runs, then the program waits for events with the step armed
  await until(() => ide.mode === 'run');
  expect(ide.mode).toBe('run');
  clickButton();
  await until(() => ide.mode === 'break');
  expect(w.win.el.querySelector('.cm-line.cm-vb-break')!.textContent).toBe('  b = 2');
  await rc.start(false);   // F5: continue, stepping ends
  await until(() => ide.mode === 'run');
  w.toggleBreakpoint(6);   // F9 while running reaches the program
  clickButton();
  await until(() => ide.mode === 'break');
  expect(w.win.el.querySelector('.cm-line.cm-vb-break')!.textContent).toBe('  c = 3');
});
