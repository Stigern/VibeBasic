// @vitest-environment jsdom
// Controls, Forms, Screen.ActiveForm / ActiveControl, Clipboard, and Load / Unload of visible control array elements.
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

type C = [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?, number?];
let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });
const tick = () => new Promise(r => setTimeout(r, 0));

async function run(forms: { name: string; code: string; controls?: C[] }[], backend: Partial<Backend> = {}) {
  const p = newProject();
  p.forms = [];
  p.startupForm = forms[0].name;
  for (const f of forms) {
    const fd = newForm(f.name, f.code);
    for (const [type, name, props, index] of f.controls ?? []) {
      const c = newControl(fd, type, { left: 120, top: 120 }, null);
      c.name = name; c.index = index ?? null;
      Object.assign(c.props, props ?? {});
      fd.controls.push(c);
    }
    p.forms.push(fd);
  }
  const out: string[] = [];
  session = new RunSession(p, new InlineFormHost(container, backend as Backend), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 20; i++) await tick();
  await new Promise(r => setTimeout(r, 30));
  return { out, p };
}

test('Controls, Forms, Screen.ActiveForm / ActiveControl and Clipboard', async () => {
  let clip = 'old';
  const { out } = await run([{
    name: 'Form1',
    code: [
      'Private Sub Form_Activate()',
      '  Dim c As Control, s As String, f As Form',
      '  For Each c In Controls: s = s & c.Name & " ": Next',
      '  Debug.Print Controls.Count; Me.Count; s; Controls(0).Name; Me.Controls.Item(2).Index',
      '  Load Form2',
      '  For Each f In Forms: s = s & f.Name & ";": Next',
      '  Debug.Print Forms.Count; Forms(1).Name; s',
      '  Debug.Print Screen.ActiveForm.Name',
      '  Text1.SetFocus',
      '  Debug.Print Screen.ActiveControl.Name; " "; Me.ActiveControl.Name',
      '  Debug.Print Clipboard.GetText(); Clipboard.GetFormat(vbCFText)',
      '  Clipboard.SetText "hello"',
      '  Debug.Print Clipboard.GetText',
      '  Clipboard.Clear',
      '  Debug.Print "[" & Clipboard.GetText() & "]"; Clipboard.GetFormat(vbCFText)',
      '  On Error Resume Next',
      '  Debug.Print Controls(9).Name',
      '  Debug.Print Err.Number',
      'End Sub',
    ].join('\n'),
    controls: [['TextBox', 'Text1'], ['CommandButton', 'Command1', {}, 0], ['CommandButton', 'Command1', {}, 1]],
  }, { name: 'Form2', code: '' }], {
    clipboardGetText: async () => clip, clipboardSetText: async t => { clip = t; },
  });
  expect(out).toEqual([
    ' 3  3 Text1 Command1 Command1 Text1 1 ',
    ' 2 Form2Text1 Command1 Command1 Form1;Form2;',
    'Form1',
    'Text1 Text1',
    'oldTrue',
    'hello',
    '[]False',
    ' 9 ',
  ]);
  expect(clip).toBe('');
});

test('Load and Unload of visible control array elements; errors 360, 343 and 362', async () => {
  const { out, p } = await run([{
    name: 'Form1',
    code: [
      'Private Sub Form_Load()',
      '  Command1(0).Caption = "Base"',
      '  Load Command1(1)',
      '  Load Command1(2)',
      '  Command1(1).Top = 2000: Command1(1).Visible = True',
      '  Debug.Print Command1.Count; Command1(1).Caption; Command1(1).Visible; Command1(2).Visible',
      '  On Error Resume Next',
      '  Load Command1(1): Debug.Print Err.Number: Err.Clear',
      '  Load Text1(1): Debug.Print Err.Number: Err.Clear',
      '  Unload Command1(0): Debug.Print Err.Number: Err.Clear',
      '  Unload Command1(2)',
      '  Debug.Print Err.Number; Command1.Count; Command1.UBound',
      'End Sub',
      'Private Sub Command1_Click(Index As Integer)',
      '  Debug.Print "click"; Index',
      'End Sub',
    ].join('\n'),
    controls: [['CommandButton', 'Command1', {}, 0], ['TextBox', 'Text1']],
  }]);
  expect(out).toEqual([' 3 BaseTrueFalse', ' 360 ', ' 343 ', ' 362 ', ' 0  2  1 ']);
  const id = `${p.forms[0].controls[0].id}~1`;
  const el = container.querySelector<HTMLElement>(`[data-control-id="${id}"]`)!;
  expect(el).not.toBeNull();
  expect(el.style.display).not.toBe('none');
  expect(container.querySelector(`[data-control-id="${p.forms[0].controls[0].id}~2"]`)).toBeNull();
  el.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  for (let i = 0; i < 10; i++) await tick();
  expect(out.at(-1)).toBe('click 1 ');
});

test('Load of an OptionButton element whose lowest one is selected starts unselected (one selected option per group)', async () => {
  const { out } = await run([{
    name: 'Form1',
    code: [
      'Private Sub Form_Load()',
      '  Option1(0).Value = True',
      '  Load Option1(1)',
      '  Option1(1).Visible = True',
      '  Debug.Print Option1(0).Value; Option1(1).Value',
      'End Sub',
    ].join('\n'),
    controls: [['OptionButton', 'Option1', {}, 0]],
  }]);
  expect(out).toEqual(['TrueFalse']);
});
