// @vitest-environment jsdom
// Review 08 (runtime): one regression test per finding, each with the VB program of the report.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession, type SessionCallbacks } from '../../src/run/session';
import { FakeDb } from './fakeDb';

type C = [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?, number?];
function project(forms: { name: string; code: string; controls?: C[]; props?: Record<string, PropValue> }[]): Project {
  const p = newProject();
  p.forms = [];
  p.startupForm = forms[0].name;
  for (const f of forms) {
    const fd = newForm(f.name, f.code);
    Object.assign(fd.props, f.props ?? {});
    let top = 120;
    for (const [type, name, props, index] of f.controls ?? []) {
      const c = newControl(fd, type, { left: 120, top }, null);
      top += 600;
      c.name = name; c.index = index ?? null;
      Object.assign(c.props, props ?? {});
      fd.controls.push(c);
    }
    p.forms.push(fd);
  }
  return p;
}

let container: HTMLElement;
let out: string[];
let ended: number;
let current: Project;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); out = []; ended = 0; });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

async function start(p: Project, cb: Partial<SessionCallbacks> = {}, backend?: unknown): Promise<RunSession> {
  current = p;
  session = new RunSession(p, new InlineFormHost(container, backend as Backend | undefined), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => { ended++; },
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app', ...cb,
  }, 'ide');
  await session.start();
  await settle(session);
  return session;
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(s: RunSession): Promise<void> {
  for (let i = 0; i < 400 && (i < 10 || s.program.state === 'running'); i++) await tick();
  await new Promise(r => setTimeout(r, 30));
}
function elOf(name: string, index: number | null = null): HTMLElement {
  for (const f of current.forms) {
    const c = f.controls.find(d => d.name === name && d.index === index);
    if (c) { const el = container.querySelector<HTMLElement>(`[data-control-id="${c.id}"]`); if (el) return el; }
  }
  throw new Error(`no control ${name}`);
}
const inputOf = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  (elOf(name).querySelector<HTMLElement>('input, textarea, select, button, [role=scrollbar]') ?? elOf(name)) as unknown as T;
const click = (name: string) => inputOf<HTMLElement>(name).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
const forms = () => [...container.querySelectorAll<HTMLElement>('.vb-form')];
const closeBox = (form: HTMLElement) => form.querySelector<HTMLElement>('.title-bar-controls button[aria-label="Close"]')!;

describe('review 08 runtime', () => {
  test('1: reading a Public variable of an unloaded form does not load it again; the program ends', async () => {
    const s = await start(project([
      { name: 'Form1', code: `Private Sub Command1_Click()
  frmLogin.Show vbModal
  Debug.Print "OK=" & frmLogin.OK
  Unload Me
End Sub`, controls: [['CommandButton', 'Command1']] },
      { name: 'frmLogin', code: `Public OK As Boolean
Private Sub Form_Load(): Debug.Print "login load": End Sub
Private Sub Form_Unload(Cancel As Integer): Debug.Print "login unload": End Sub
Private Sub cmdOK_Click(): OK = True: Unload Me: End Sub`, controls: [['CommandButton', 'cmdOK']] },
    ]));
    click('Command1'); await settle(s);
    click('cmdOK'); await settle(s);
    expect(out).toEqual(['login load', 'login unload', 'OK=True']);
    expect(s.state).toBe('ended');
  });

  test('1: a Public Sub of an unloaded form that sets a control loads it (VB6)', async () => {
    const s = await start(project([
      { name: 'Form1', code: `Private Sub Command1_Click()
  Form2.Fill
  Debug.Print Form2.Text1.Text
End Sub`, controls: [['CommandButton', 'Command1']] },
      { name: 'Form2', code: `Private Sub Form_Load(): Debug.Print "load2": End Sub
Public Sub Fill(): Text1.Text = "x": End Sub`, controls: [['TextBox', 'Text1']] },
    ]));
    click('Command1'); await settle(s);
    expect(out).toEqual(['load2', 'x']);
  });
  test('2: TextBox SelStart / SelLength select in the field, and reads give the user\'s selection', async () => {
    const s = await start(project([{ name: 'Form1', code: `Private Sub Command1_Click()
  Text1.SelStart = 6: Text1.SelLength = 5
End Sub
Private Sub Command2_Click()
  Debug.Print Text1.SelStart & "," & Text1.SelLength & "," & Text1.SelText
  Text1.SelText = "X"
  Debug.Print Text1.Text
  On Error Resume Next
  Text1.SelStart = -1
  Debug.Print CStr(Err.Number)
  Err.Clear
  Text1.SelStart = 99: Text1.SelLength = 99
  Debug.Print Text1.SelStart & "," & Text1.SelLength
End Sub`, controls: [['TextBox', 'Text1', { Text: 'hello world' }], ['CommandButton', 'Command1'], ['CommandButton', 'Command2']] }]));
    click('Command1'); await settle(s);
    const t = inputOf('Text1');
    t.focus();   // set while the field had no focus: selected when it gets it
    expect([t.selectionStart, t.selectionEnd]).toEqual([6, 11]);
    t.setSelectionRange(0, 2);
    t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    click('Command2'); await settle(s);
    expect(out).toEqual(['0,2,he', 'Xllo world', '380', '10,0']);
    expect(t.value).toBe('Xllo world');
  });

  test('2: moving the caret sends nothing until a message follows (or a pause)', async () => {
    const { mountFormWindow } = await import('../../src/run/formWindow');
    const def = newControl(newForm('F', ''), 'TextBox', { left: 0, top: 0 }, null);
    def.props.Text = 'hello';
    const b = newControl(newForm('F', ''), 'CommandButton', { left: 0, top: 600 }, null);
    const sent: unknown[] = [];
    const w = mountFormWindow(container, { key: 'F', form: { id: 'f', name: 'F', code: '', props: {}, controls: [def, b] }, assets: {}, handled: { [b.id]: ['Click'] }, mode: 'ide' }, m => sent.push(m));
    await tick();
    sent.length = 0;
    const t = container.querySelector<HTMLInputElement>(`[data-control-id="${def.id}"] input`)!;
    for (let i = 1; i <= 4; i++) { t.setSelectionRange(i, i); t.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); }
    expect(sent).toEqual([]);
    container.querySelector<HTMLElement>(`[data-control-id="${b.id}"] button`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toEqual([{ t: 'state', id: def.id, props: { SelStart: 4, SelLength: 0 } }, { t: 'event', id: b.id, event: 'Click', args: [] }]);
    w.dispose();
  });

  test('6: a multi-line TextBox gives line breaks as vbCrLf', async () => {
    const s = await start(project([{ name: 'Form1', code: `Private Sub Command1_Click()
  Debug.Print Len(Text2.Text) & " " & InStr(Text2.Text, vbCrLf) & " " & UBound(Split(Text2.Text, vbCrLf))
  Debug.Print CStr(Text2.SelStart)
End Sub`, controls: [['TextBox', 'Text2', { MultiLine: true }], ['CommandButton', 'Command1']] }]));
    const t = inputOf<HTMLTextAreaElement>('Text2');
    t.value = 'ab\ncd';
    t.setSelectionRange(5, 5);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    click('Command1'); await settle(s);
    expect(out).toEqual(['6 3 1', '6']);
    expect(t.value).toBe('ab\ncd');
  });
  test('7: Escape and Ctrl+letter raise KeyPress (27, 1 .. 26)', async () => {
    const s = await start(project([{ name: 'Form1', props: { KeyPreview: true }, code: `Private Sub Form_KeyPress(KeyAscii As Integer)
  Debug.Print CStr(KeyAscii)
End Sub`, controls: [['TextBox', 'Text1', { Text: '' }]] }]));
    const t = inputOf('Text1');
    const key = (k: string, init: KeyboardEventInit = {}) => t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
    key('a'); await settle(s);
    const esc = key('Escape'); await settle(s);
    const copy = key('c', { ctrlKey: true }); await settle(s);
    key(']', { ctrlKey: true }); await settle(s);
    key('q', { metaKey: true }); await settle(s);   // Cmd: the menus'
    expect(out).toEqual(['97', '27', '3', '29']);
    expect([esc, copy]).toEqual([true, true]);   // the field keeps its own action (copy ...)
    expect(t.value).toBe('a');
  });

  test('8: Activate again when a modal form closes; Deactivate when another form is activated', async () => {
    const s = await start(project([
      { name: 'Form1', code: `Private Sub Form_Activate(): Debug.Print "F1 activate": End Sub
Private Sub Form_Deactivate(): Debug.Print "F1 deactivate": End Sub
Private Sub Command1_Click(): frmLogin.Show vbModal: End Sub
Private Sub Command2_Click(): Form2.Show: End Sub`, controls: [['CommandButton', 'Command1'], ['CommandButton', 'Command2'], ['TextBox', 'Text1']] },
      { name: 'frmLogin', code: 'Private Sub cmdOK_Click(): Unload Me: End Sub', controls: [['CommandButton', 'cmdOK']] },
      { name: 'Form2', code: `Private Sub Form_Activate(): Debug.Print "F2 activate": End Sub
Private Sub Form_Deactivate(): Debug.Print "F2 deactivate": End Sub`, controls: [['TextBox', 'Text2']] },
    ]));
    click('Command1'); await settle(s);
    click('cmdOK'); await settle(s);
    expect(out).toEqual(['F1 activate', 'F1 deactivate', 'F1 activate']);
    out.length = 0;
    click('Command2'); await settle(s);
    inputOf('Text1').focus(); await settle(s);   // the user goes back to Form1
    inputOf('Text1').blur(); inputOf('Text1').focus(); await settle(s);   // focus from outside again: still the active form
    expect(out).toEqual(['F1 deactivate', 'F2 activate', 'F2 deactivate', 'F1 activate']);
  });

  test('16: on Show, the first control gets the focus after Form_Resize and Form_Activate', async () => {
    await start(project([{ name: 'Form1', code: ['Initialize', 'Load', 'Resize', 'Activate']
      .map(e => `Private Sub Form_${e}()\n    Debug.Print "${e}"\nEnd Sub\n`).join('') + 'Private Sub Text1_GotFocus(): Debug.Print "GotFocus": End Sub',
    controls: [['TextBox', 'Text1']] }]));
    expect(out).toEqual(['Initialize', 'Load', 'Resize', 'Activate', 'GotFocus']);
    expect(document.activeElement).toBe(inputOf('Text1'));
  });

  test('16: SetFocus in Form_Activate wins over the first control', async () => {
    await start(project([{ name: 'Form1', code: 'Private Sub Form_Activate(): Text2.SetFocus: End Sub', controls: [['TextBox', 'Text1'], ['TextBox', 'Text2']] }]));
    expect(document.activeElement).toBe(inputOf('Text2'));
  });
});
