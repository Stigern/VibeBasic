import { expect, test } from 'vitest';
import { stripThinking } from '../../src/ai/clean';
import { buildCodeRequest, buildFormRequest, describeControlTypes, describeForm, describeProjectForms } from '../../src/ai/context';
import { CODE_SYSTEM_PROMPT, FORM_SYSTEM_PROMPT } from '../../src/ai/prompts';
import { newForm, newProject } from '../../src/model/controls';
import type { ControlDef, FormDef } from '../../src/model/types';

const ctl = (id: string, type: ControlDef['type'], name: string, props: ControlDef['props'], extra: Partial<ControlDef> = {}): ControlDef =>
  ({ id, type, name, index: null, parentId: null, props, ...extra });
const sampleForm = (): FormDef => {
  const f = newForm('Form1', 'Option Explicit\nPrivate Sub Command1_Click()\n  x = 1\nEnd Sub');
  f.props.Caption = 'Login';
  f.controls = [
    ctl('a', 'CommandButton', 'cmdOK', { Left: 1200, Top: 2400, Width: 1215, Height: 495, Caption: 'OK', Default: true, Cancel: false }),
    ctl('b', 'TextBox', 'Text1', { Left: 1200, Top: 600, Width: 2415, Height: 315, Text: '' }),
    ctl('c', 'CommandButton', 'Command1', { Left: 120, Top: 120, Width: 495, Height: 495, Caption: '1' }, { index: 0 }),
    ctl('d', 'Frame', 'Frame1', { Left: 0, Top: 0, Width: 2000, Height: 2000 }),
    ctl('e', 'Label', 'Label1', { Left: 120, Top: 240, Width: 1215, Height: 255, Caption: 'Navn:' }, { parentId: 'd' }),
  ];
  return f;
};
const expectedLines = [
  'Form Form1 Caption="Login" Width=4800 Height=3600',
  'CommandButton cmdOK Left=1200 Top=2400 Width=1215 Height=495 Caption="OK" Default=True',
  'TextBox Text1 Left=1200 Top=600 Width=2415 Height=315 Text=""',
  'CommandButton Command1(0) Left=120 Top=120 Width=495 Height=495 Caption="1"',
  'Frame Frame1 Left=0 Top=0 Width=2000 Height=2000',
  'Label Label1 in Frame1 Left=120 Top=240 Width=1215 Height=255 Caption="Navn:"',
].join('\n');
const project = () => {
  const p = newProject();
  p.forms = [sampleForm()];
  p.forms[0].controls = p.forms[0].controls.slice(0, 1).concat([ctl('b', 'TextBox', 'Text1', {})]);
  p.modules = [{ id: 'm1', name: 'Module1', code: 'Sub Main()\nEnd Sub' }];
  return p;
};

test('strip thinking', () => expect(stripThinking('<think>hmm\nja</think>\nSvar')).toBe('Svar'));
test('describe form exact', () => expect(describeForm(sampleForm())).toBe(expectedLines));
test('code request mentions current procedure', () => {
  const p = project();
  const m = buildCodeRequest(p, p.forms[0].id, 3, 'tell til 10');
  expect(m).toHaveLength(2);
  expect(m[0].content).toContain(CODE_SYSTEM_PROMPT);
  expect(m[1].content).toContain('Current procedure: Command1_Click');
  expect(m[1].content).toMatch(/Request: tell til 10$/);
  expect(buildCodeRequest(p, p.forms[0].id, 1, 'x')[1].content).toContain('Current procedure: (none)');
});
test('module request lists forms', () => {
  const p = project();
  expect(buildCodeRequest(p, 'm1', 1, 'x')[1].content).toContain('Form1: cmdOK (CommandButton), Text1 (TextBox)');
  expect(describeProjectForms(p)).toContain('Text1 (TextBox)');
});
test('form request', () => {
  const p = project();
  const m = buildFormRequest(p, p.forms[0].id, 'legg til knapp');
  expect(m[0].content).toContain(FORM_SYSTEM_PROMPT);
  expect(m[1].content).toContain('Form Form1');
  expect(m[1].content).toContain('Private Sub Command1_Click()');
});
test('control types one line per type', () => expect(describeControlTypes()).toContain('CommandButton: Caption, '));
test('system prompts contain format rules', () => { expect(CODE_SYSTEM_PROMPT).toContain('```vb'); expect(FORM_SYSTEM_PROMPT).toContain('"ops"'); });
