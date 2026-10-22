import { expect, test } from 'vitest';
import { stripThinking } from '../../src/ai/clean';
import { buildCodeRequest, buildFormRequest, codeForPrompt, describeControlTypes, describeForm, describeProjectForms } from '../../src/ai/context';
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

test('system prompts are identical for different projects', () => {
  const p1 = project();
  const p2 = project();
  p2.forms[0].name = 'Other';
  p2.forms[0].code = 'Private Sub Other_Load()\nEnd Sub';
  p2.modules = [];
  const sys = (m: { role: string; content: string }[]) => m[0].content;
  expect(sys(buildCodeRequest(p1, 'm1', 1, 'a'))).toBe(sys(buildCodeRequest(p2, p2.forms[0].id, 1, 'b')));
  expect(sys(buildFormRequest(p1, p1.forms[0].id, 'a'))).toBe(sys(buildFormRequest(p2, p2.forms[0].id, 'b')));
  expect(sys(buildCodeRequest(p1, 'm1', 1, 'a'))).toContain('Option Explicit');
});

test('user message order: form description, code, request', () => {
  const p = project();
  const u = buildCodeRequest(p, p.forms[0].id, 1, 'REQ')[1].content;
  expect(u.indexOf('Form description')).toBeLessThan(u.indexOf('Code of form'));
  expect(u.indexOf('Code of form')).toBeLessThan(u.indexOf('Request: REQ'));
});

const bigModule = (): string => {
  const parts = ['Option Explicit', 'Dim total As Integer', ''];
  for (let i = 0; i < 50; i++) {
    parts.push(`Private Sub Proc${i}(x As Integer)`);
    for (let k = 0; k < 7; k++) parts.push(`    total = total + ${i * 10 + k}`);
    if (i === 3) parts.push('    Helper 1');
    parts.push('End Sub', '');
  }
  parts.push('Private Sub Helper(n As Integer)', '    total = n', '    total = total * 2', 'End Sub');
  return parts.join('\n');
};

test('codeForPrompt leaves a short module unchanged', () => {
  const code = 'Dim x\nPrivate Sub A()\n  x = 1\nEnd Sub';
  expect(codeForPrompt(code, { procName: 'A', mention: '' })).toBe(code);
});

test('codeForPrompt: 500 lines keep the current procedure, the one it calls and the one named in the request', () => {
  const code = bigModule();
  expect(code.split('\n').length).toBeGreaterThan(400);
  const out = codeForPrompt(code, { procName: 'Proc3', mention: 'also check proc10 please' });
  expect(out).toContain('Option Explicit\nDim total As Integer');
  expect(out).toContain('    total = total + 36');                 // Proc3 in full
  expect(out).toContain('    total = total * 2');                  // Helper, called from Proc3
  expect(out).toContain('    total = total + 106');                // Proc10, named in the request (any case)
  expect(out).not.toContain('    total = total + 206');            // Proc20 body omitted
  expect(out).toContain("Private Sub Proc20(x As Integer)\n' ... (body omitted)");
  expect(out.split('\n').length).toBeLessThan(code.split('\n').length / 2);
});
