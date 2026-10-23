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
  const r = parseFormOps('{"ops":[{"op":"add","type":"Label","props":{"Foo":1}},{"op":"add","type":"Gizmo"},{"op":"add","type":"CommandButton","name":"cmdOK","props":{"Left":"abc"}},{"op":"delete","name":"Label9"}]}', p.forms[0]) as any;
  expect(r.warnings).toEqual(['Ignored unknown property Foo on Label.', 'Ignored unknown control type Gizmo.',
    'Ignored invalid value for Left on cmdOK.', 'Ignored change to missing control Label9.']);
});
test('taken name is renamed', () => {
  const { p } = setup();
  const r = parseFormOps('{"ops":[{"op":"add","type":"Label","name":"cmdOK"},{"op":"add","type":"Label","name":"cmdOK","props":{"Top":600}}]}', p.forms[0]) as any;
  expect(r.ops.map((o: any) => o.name)).toEqual(['cmdOK', 'cmdOK1']);
  expect(r.warnings).toContain('Renamed cmdOK to cmdOK1 because the name was taken.');
});
test('pixels converted', () => {
  const r = parseFormOps('{"ops":[{"op":"add","type":"CommandButton","name":"cmdOK","props":{"Left":10,"Width":80,"Height":30}}]}', setup().p.forms[0]) as any;
  expect(r.ops[0].props).toMatchObject({ Left: 150, Width: 1200, Height: 450 });
  expect(r.warnings).toContain('Sizes for cmdOK looked like pixels and were converted to twips.');
});
test('garbage is not understood', () => {
  expect(parseFormOps('Jeg kan ikke det.', setup().p.forms[0])).toEqual({ ok: false, error: 'The AI answer could not be understood. Try again or rephrase.', raw: 'Jeg kan ikke det.', reason: 'no JSON object found' });
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
  expect(await pr).toBe('ok');
  pr = showFormPreview(document, form, [], []);
  click('Cancel');
  expect(await pr).toBe('cancel');
});
test('undo keeps hand edits made after the AI change', () => {
  const { p, stack } = setup();
  const f = () => p.forms[0];
  f().code = 'Option Explicit\n\nPrivate Sub Form_Load()\nEnd Sub';
  const r = parseFormOps(sampleReply, f());
  if (!r.ok) throw new Error('parse');
  stack.execute(formOpsToCommand(p, f().id, r, 'AI changes'));
  expect(f().code).toContain('cmdOK_Click');
  // hand edit elsewhere (inside Form_Load, before the AI span), as the code window writes it
  f().code = f().code.replace('Private Sub Form_Load()\n', 'Private Sub Form_Load()\n    x = 1\n');
  stack.undo();
  expect(f().controls.map(c => c.name)).toEqual(['Text1', 'Label1']);
  expect(f().code).toBe('Option Explicit\n\nPrivate Sub Form_Load()\n    x = 1\nEnd Sub');
  stack.redo();
  expect(f().code).toContain('    x = 1\n');
  expect(f().code).toContain('cmdOK_Click');
  // edit inside the AI span: undo restores the controls but leaves the code alone
  f().code = f().code.replace('MsgBox "Hei "', 'MsgBox "Hallo "');
  const edited = f().code;
  stack.undo();
  expect(f().controls.map(c => c.name)).toEqual(['Text1', 'Label1']);
  expect(f().code).toBe(edited);
});
test('no mixed or invalid control arrays', () => {
  const { p } = setup();
  const f = p.forms[0];
  f.controls.push({ ...newControl(f, 'CommandButton', { left: 0, top: 0 }, null), name: 'cmdA', index: 0 });
  const r = parseFormOps(JSON.stringify({ ops: [
    { op: 'add', type: 'CommandButton', name: 'Text1(1)' },     // Text1 is not an array
    { op: 'add', type: 'Label', name: 'cmdA(1)' },              // type differs
    { op: 'add', type: 'CommandButton', name: 'cmdA(0)' },      // index exists
    { op: 'add', type: 'CommandButton', name: 'cmdA(1)' },      // valid new member
  ] }), f) as any;
  expect(r.ops.map((o: any) => `${o.name}(${o.index})`)).toEqual(['Text11(null)', 'cmdA1(null)', 'cmdA2(null)', 'cmdA(1)']);
  expect(r.warnings).toContain('Renamed Text1 to Text11 because the name was taken.');
});
test('small-model quirks: op aliases, loose props, bare array, raw newlines', () => {
  const { p } = setup();
  const reply = '[{"op":"create","type":"Label","name":"lblA","Caption":"Line1\nLine2\tx"},{"op":"update","name":"Text1","Text":"hi"},{"op":"remove","name":"Label1"},{"op":"move","name":"Text1","Left":300}]';
  const r = parseFormOps(reply, p.forms[0]) as any;
  expect(r.ok).toBe(true);
  expect(r.ops).toEqual([
    { op: 'add', type: 'Label', name: 'lblA', index: null, container: null, props: { Caption: 'Line1\nLine2\tx' } },
    { op: 'set', name: 'Text1', index: null, props: { Text: 'hi' } },
    { op: 'delete', name: 'Label1', index: null },
    { op: 'set', name: 'Text1', index: null, props: { Left: 300 } },
  ]);
});
test('all ops ignored: warnings go into the details text', () => {
  const r = parseFormOps('{"ops":[{"op":"add","type":"Gizmo"}]}', setup().p.forms[0]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.raw).toContain('Ignored unknown control type Gizmo.');
});

test('the menu op adds menus in order (one undo step); describeForm lists them and the validator accepts their Click code', async () => {
  const { describeForm } = await import('../../src/ai/context');
  const { validateCode } = await import('../../src/ai/validate');
  const { menuTree } = await import('../../src/model/menus');
  const { p, stack } = setup();
  const reply = JSON.stringify({ ops: [
    { op: 'menu', name: 'mnuFile', caption: '&File', parent: null },
    { op: 'menu', name: 'mnuOpen', caption: '&Open...', parent: 'mnuFile', shortcut: 'Ctrl+O' },
    { op: 'menu', name: 'mnuRecent', caption: 'Recent', parent: 'mnuFile', index: 0, checked: true },
    { op: 'menu', name: 'mnuLost', caption: 'Lost', parent: 'mnuNothing' }],
    code: 'Private Sub mnuOpen_Click()\n    PopupMenu mnuFile\nEnd Sub\nPrivate Sub mnuRecent_Click(Index As Integer)\nEnd Sub' });
  const r = parseFormOps(reply, p.forms[0]);
  if (!r.ok) throw new Error('not parsed');
  expect(describeOps(r).slice(0, 3)).toEqual(['Add Menu mnuFile', 'Add Menu mnuOpen', 'Add Menu mnuRecent(0)']);
  expect(r.warnings).toEqual(['Ignored menu mnuLost: there is no menu mnuNothing.']);
  stack.execute(formOpsToCommand(p, p.forms[0].id, r, 'AI'));
  const tree = menuTree(p.forms[0].controls);
  expect(tree.map(n => [n.def.name, n.children.map(c => [c.def.name, c.def.index, c.def.props.Shortcut, c.def.props.Checked])]))
    .toEqual([['mnuFile', [['mnuOpen', null, 15, false], ['mnuRecent', 0, 0, true]]]]);
  expect(describeForm(p.forms[0])).toContain('Menu mnuOpen in mnuFile Caption="&Open..." Shortcut="Ctrl+O"');
  expect(validateCode(p.forms[0].code, { moduleName: 'Form1', form: p.forms[0], project: p })).toEqual([]);
  stack.undo();
  expect(p.forms[0].controls.some(c => c.type === 'Menu')).toBe(false);
});
