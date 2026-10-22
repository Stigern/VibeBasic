// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { applyFormOpsToClone, describeOps, formOpsToCommand, parseFormOps } from '../../src/ai/formMode';
import { showFormPreview } from '../../src/ai/previewDialogs';
import { CommandStack } from '../../src/model/commands';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { Project } from '../../src/model/types';

function setup(): { p: Project; stack: CommandStack } {
  const p = newProject();
  const f = p.forms[0];
  f.code = 'Option Explicit\n';
  f.controls.push(newControl(f, 'TextBox', { left: 100, top: 100 }, null));
  f.controls.push(newControl(f, 'Label', { left: 100, top: 600 }, null));
  return { p, stack: new CommandStack(() => p, () => {}) };
}
const sampleReply = JSON.stringify({ ops: [
  { op: 'add', type: 'CommandButton', name: 'cmdOK', container: null, props: { Caption: 'OK', Left: 1200, Top: 2400, Width: 1215, Height: 495 } },
  { op: 'set', name: 'Text1', props: { Text: '' } },
  { op: 'delete', name: 'Label1' },
  { op: 'form', props: { Caption: 'Login' } }],
  code: 'Private Sub cmdOK_Click()\n    MsgBox "Hei " & Text1.Text\nEnd Sub' });

test('valid ops parsed', () => {
  const { p } = setup();
  const r = parseFormOps(sampleReply, p.forms[0]);
  expect(r.ok && r.ops.map(o => o.op)).toEqual(['add', 'set', 'delete', 'form']);
  if (r.ok) expect(describeOps(r)).toEqual(['Add CommandButton cmdOK', 'Set Text1.Text = ""', 'Delete Label1', 'Set Form.Caption = "Login"', 'Add code: cmdOK_Click']);
});
test('fenced json with trailing comma, comment and thinking', () => {
  const { p } = setup();
  const r = parseFormOps('<think>x</think>```json\n{"ops":[{"op":"add","type":"button", // c\n"props":{"Caption":"a//b",}},]}\n```', p.forms[0]);
  expect(r.ok && r.ops[0]).toMatchObject({ type: 'CommandButton', props: { Caption: 'a//b' } });
});
test('alias and default name', () => {
  const r = parseFormOps('{"ops":[{"op":"add","type":"RadioButton"}]}', setup().p.forms[0]) as any;
  expect(r.ops[0]).toMatchObject({ type: 'OptionButton', name: 'Option1' });
});
test('unknown prop, type, invalid value and missing control warn', () => {
  const { p } = setup();
  const r = parseFormOps('{"ops":[{"op":"add","type":"Label","props":{"Foo":1}},{"op":"add","type":"Slider"},{"op":"add","type":"CommandButton","name":"cmdOK","props":{"Left":"abc"}},{"op":"delete","name":"Label9"}]}', p.forms[0]) as any;
  expect(r.warnings).toEqual(['Ignored unknown property Foo on Label.', 'Ignored unknown control type Slider.',
    'Ignored invalid value for Left on cmdOK.', 'Ignored change to missing control Label9.']);
});
test('taken name is renamed', () => {
  const { p } = setup();
  const r = parseFormOps('{"ops":[{"op":"add","type":"Label","name":"cmdOK"},{"op":"add","type":"Label","name":"cmdOK"}]}', p.forms[0]) as any;
  expect(r.ops.map((o: any) => o.name)).toEqual(['cmdOK', 'cmdOK1']);
  expect(r.warnings).toContain('Renamed cmdOK to cmdOK1 because the name was taken.');
});
test('pixels converted', () => {
  const r = parseFormOps('{"ops":[{"op":"add","type":"CommandButton","name":"cmdOK","props":{"Left":10,"Width":80,"Height":30}}]}', setup().p.forms[0]) as any;
  expect(r.ops[0].props).toMatchObject({ Left: 150, Width: 1200, Height: 450 });
  expect(r.warnings).toContain('Sizes for cmdOK looked like pixels and were converted to twips.');
});
test('garbage is not understood', () => {
  expect(parseFormOps('Jeg kan ikke det.', setup().p.forms[0])).toEqual({ ok: false, error: 'The AI answer could not be understood. Try again or rephrase.', raw: 'Jeg kan ikke det.' });
  expect(parseFormOps('{"ops":[{"op":"delete","name":"Nope"}]}', setup().p.forms[0]).ok).toBe(false);
});
test('control array name parsed', () => {
  const { p } = setup();
  const r = parseFormOps('{"ops":[{"op":"add","type":"CommandButton","name":"Command1(2)"}]}', p.forms[0]) as any;
  expect(r.ops[0]).toMatchObject({ name: 'Command1', index: 2 });
});
test('one undo step including code', () => {
  const { p, stack } = setup();
  const before = structuredClone(p.forms[0]);
  const r = parseFormOps(sampleReply, p.forms[0]);
  if (!r.ok) throw new Error('parse');
  stack.execute(formOpsToCommand(p, p.forms[0].id, r, 'AI changes'));
  const f = p.forms[0];
  expect(f.controls.map(c => c.name)).toEqual(['Text1', 'cmdOK']);
  expect(f.controls[0].props.Text).toBe('');
  expect(f.controls[1].props).toMatchObject({ Caption: 'OK', Left: 1200, Width: 1215 });
  expect(f.props.Caption).toBe('Login');
  expect(f.code).toContain('cmdOK_Click');
  stack.undo();
  expect(p.forms[0]).toEqual(before);
  expect(stack.canUndo).toBe(false);
});
test('clone preview does not touch the original', () => {
  const { p } = setup();
  const r = parseFormOps(sampleReply, p.forms[0]);
  if (!r.ok) throw new Error('parse');
  const before = structuredClone(p.forms[0]);
  const c = applyFormOpsToClone(p.forms[0], r);
  expect(c.controls.map(x => x.name)).toEqual(['Text1', 'cmdOK']);
  expect(p.forms[0]).toEqual(before);
});
test('form preview dialog OK / Cancel', async () => {
  const form = newForm('Form1');
  const click = (label: string) => [...document.querySelectorAll('.dlg98 button')].find(b => b.textContent === label)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  let pr = showFormPreview(document, form, ['Add Label Label1'], ['careful']);
  expect(document.querySelector('.ai-ops')!.textContent).toContain('Add Label Label1');
  expect(document.querySelector('.ai-warning')!.textContent).toBe('careful');
  click('OK');
  expect(await pr).toBe(true);
  pr = showFormPreview(document, form, [], []);
  click('Cancel');
  expect(await pr).toBe(false);
});
