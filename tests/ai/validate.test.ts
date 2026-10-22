import { expect, test } from 'vitest';
import { autoFixEventNames, validateCode } from '../../src/ai/validate';
import { newControl, newProject } from '../../src/model/controls';

const form = () => {
  const f = newProject().forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 0, top: 0 }, null), newControl(f, 'Timer', { left: 0, top: 0 }, null));
  return f;   // Command1, Timer1
};

test('autoFixEventNames renames FormName_Event headers only', () => {
  const r = autoFixEventNames('Private Sub Form1_Load()\n    Form1_Resize\n    x = 1\nEnd Sub\n\nPublic Sub form1_click ()\nEnd Sub\nSub Form1_Custom()\nEnd Sub', 'Form1');
  expect(r.code).toBe('Private Sub Form_Load()\n    Form1_Resize\n    x = 1\nEnd Sub\n\nPublic Sub Form_Click ()\nEnd Sub\nSub Form1_Custom()\nEnd Sub');
  expect(r.notes).toEqual(['Renamed Form1_Load to Form_Load', 'Renamed form1_click to Form_Click']);
  expect(autoFixEventNames('Sub Form_Load()\nEnd Sub', 'Form1').notes).toEqual([]);
});

test('validateCode: clean code has no problems', () => {
  const f = form();
  expect(validateCode('Private Sub Command1_Click()\n    MsgBox "hi"\nEnd Sub\nPrivate Sub Form_Load()\nEnd Sub\nPrivate Sub Timer1_Timer()\nEnd Sub', { moduleName: 'Form1', form: f })).toEqual([]);
  expect(validateCode('Dim x As Integer', { moduleName: 'Form1', form: f })).toEqual([]);
  expect(validateCode('x = 1\nMsgBox x', { moduleName: 'Form1', form: f })).toEqual([]);
});

test('validateCode: syntax errors with line numbers', () => {
  const p = validateCode('Private Sub A()\n    If x Then\nEnd Sub', { moduleName: 'Form1', form: null });
  expect(p.length).toBeGreaterThan(0);
  expect(p[0]).toMatch(/^Line \d+: /);
  const bare = validateCode('x = 1\ny = = 2', { moduleName: 'Form1', form: null });
  expect(bare[0]).toMatch(/^Line 2: /);
});

test('validateCode: unknown control and wrong event', () => {
  const f = form();
  const p = validateCode('Private Sub Command9_Click()\nEnd Sub\nPrivate Sub Command1_Timer()\nEnd Sub\nPrivate Sub Helper_Done()\nEnd Sub\nPrivate Sub Do_It()\nEnd Sub', { moduleName: 'Form1', form: f });
  expect(p).toEqual(['There is no control named Command9, so Command9_Click would never run.', 'A CommandButton has no Timer event.']);
});

test('validateCode: extra controls and module code', () => {
  const f = form();
  const code = 'Private Sub lblHi_Click()\nEnd Sub';
  expect(validateCode(code, { moduleName: 'Form1', form: f })).toHaveLength(1);
  expect(validateCode(code, { moduleName: 'Form1', form: f, extraControls: [{ name: 'lblHi', type: 'Label' }] })).toEqual([]);
  expect(validateCode(code, { moduleName: 'Module1', form: null })).toEqual([]);
});
