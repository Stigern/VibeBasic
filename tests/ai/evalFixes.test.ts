// @vitest-environment jsdom
// Regression tests for the fixes from the live evaluation against a local Qwen (tests-live/report.md).
import { afterEach, expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import { buildFormRequest } from '../../src/ai/context';
import { FORM_OPS_SCHEMA, applyFormOpsToClone, growForOverflow, isTruncatedJson, parseFormOps } from '../../src/ai/formMode';
import { LANGUAGE_REFERENCE } from '../../src/ai/langReference';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, FormDef } from '../../src/model/types';

const fakeBackend = (replies: (string | (() => string))[], settings: Record<string, unknown> = {}) => {
  let i = 0;
  return {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '', ...settings }),
    saveSettings: async () => {},
    aiListModels: async () => [],
    aiChat: vi.fn(async () => { const r = replies[Math.min(i++, replies.length - 1)]; return typeof r === 'function' ? r() : r; }),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
};
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
async function enterPrompt(t: string) {
  await vi.waitFor(() => expect(btn('Ask AI')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  click('Ask AI');
}
const codeWin = (src: string) => {
  const w = { src, getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn((a: number, b: number, t: string) => { w.src = w.src.slice(0, a) + t + w.src.slice(b); }) };
  return w;
};
function ide(view: 'code' | 'designer', controls: [Exclude<ControlType, 'Form'>, string][] = [['CommandButton', 'Command1']]) {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  for (const [type, name] of controls) { const c = newControl(f, type, { left: 120, top: 120 }, null); c.name = name; f.controls.push(c); }
  s.setActiveView(view === 'code' ? { kind: 'code', itemId: f.id } : { kind: 'designer', formId: f.id });
  return s;
}
const add = (f: FormDef, type: Exclude<ControlType, 'Form'>, name: string, props: Record<string, number | string> = {}) => {
  const c = newControl(f, type, { left: 0, top: 0 }, null);
  c.name = name;
  Object.assign(c.props, props);
  f.controls.push(c);
  return c;
};
afterEach(() => { document.body.innerHTML = ''; });

// ---------------------------------------------------------------------------------------------------------------
// 2. Form mode: dropped values go back to the model; leniency where the intent is clear

test('form mode: an invalid value goes into the check-and-fix complaint with the valid values', async () => {
  const s = ide('designer');
  const bad = '{"ops":[{"op":"form","props":{"Caption":"Login","StartUpPosition":4}}]}';
  const good = '{"ops":[{"op":"form","props":{"Caption":"Login","StartUpPosition":2}}]}';
  const b = fakeBackend([bad, good]);
  const p = askAi(s, b, { codeWindowFor: () => null });
  await enterPrompt('centre it');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(b.aiChat.mock.calls[1][3].at(-1).content)
    .toContain('- Ignored invalid value 4 for StartUpPosition on Form1 (valid: 0 Manual, 1 CenterOwner, 2 CenterScreen, 3 Windows Default).');
  click('OK');
  await p;
  expect(s.project.forms[0].props.StartUpPosition).toBe(2);
});

test('form mode: an answer whose only op cannot be done is retried with the reason, not "not valid JSON"', async () => {
  const s = ide('designer');
  const b = fakeBackend(['{"ops":[{"op":"add","type":"MDIForm","name":"MDIForm1"}]}', '{"ops":[{"op":"form","props":{"Caption":"x"}}]}']);
  const p = askAi(s, b, { codeWindowFor: () => null });
  await enterPrompt('make an MDI app');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  const complaint = b.aiChat.mock.calls[1][3].at(-1).content as string;
  expect(complaint).toMatch(/^Your answer has these problems:\n- Ignored the new MDIForm MDIForm1: form mode changes only Form1 and cannot add a form\./);
  click('Cancel');
  await p;
});

test('form mode leniency: set of the form, props.tab, 1/0 Booleans, Tabs as captions, unknown ops naming a form', () => {
  const f = newForm('Form1');
  add(f, 'SSTab', 'SSTab1');
  const r = parseFormOps(JSON.stringify({ ops: [
    { op: 'set', name: 'Form1', props: { Caption: 'Main' } },
    { op: 'set', name: 'Me', props: { BorderStyle: 3 } },
    { op: 'set', name: 'SSTab1', props: { Tabs: 'General\nView\nAdvanced' } },
    { op: 'add', type: 'OptionButton', name: 'optA', container: 'SSTab1', props: { tab: 2, Value: 1, Top: 600 } },
    { op: 'add', type: 'CheckBox', name: 'chkB', props: { Value: 1 } },
    { op: 'newForm', name: 'Form2' },
  ] }), f);
  if (!r.ok) throw new Error('not parsed');
  expect(r.ops.slice(0, 2)).toEqual([{ op: 'form', props: { Caption: 'Main' } }, { op: 'form', props: { BorderStyle: 3 } }]);
  expect(r.ops[2]).toEqual({ op: 'set', name: 'SSTab1', index: null, props: { TabCaption: ['General', 'View', 'Advanced'], Tabs: 3 } });
  expect(r.ops[3]).toMatchObject({ op: 'add', name: 'optA', tab: 2, props: { Value: true, Top: 600 } });
  expect(r.ops[4]).toMatchObject({ props: { Value: 1 } });   // a CheckBox's Value is 0/1/2, not a Boolean
  expect(r.issues).toEqual([expect.stringMatching(/^Ignored operation newForm: form mode changes only Form1 and cannot add a form/)]);
  const after = applyFormOpsToClone(f, r);
  const tab = after.controls.find(c => c.name === 'SSTab1')!;
  expect([tab.props.Tabs, tab.props.TabCaption, tab.props.Caption]).toEqual([3, ['General', 'View', 'Advanced'], 'General']);
  expect(after.controls.find(c => c.name === 'optA')!.tab).toBe(2);
});

test('form mode: an added SSTab with its captions keeps Caption in step', () => {
  const f = newForm('Form1');
  const r = parseFormOps('{"ops":[{"op":"add","type":"SSTab","name":"t","props":{"Tabs":"A\\nB"}}]}', f);
  if (!r.ok) throw new Error('not parsed');
  const t = applyFormOpsToClone(f, r).controls.find(c => c.name === 't')!;
  expect([t.props.Tabs, t.props.TabCaption, t.props.Caption]).toEqual([2, ['A', 'B'], 'A']);
});

test('form mode: a placement naming no control is a problem (the "leftOf":"x" of a broken answer), and so is merged-away code', () => {
  const f = newForm('Form1');
  const r = parseFormOps('{"ops":[{"op":"add","type":"TextBox","name":"txtDisplay"},{"op":"add","type":"CommandButton","name":"cmd7","place":{"leftOf":"x"}}]}', f);
  if (!r.ok) throw new Error('not parsed');
  expect(r.issues).toEqual(['Ignored "place" of cmd7: there is no control x; name an existing control or one added before it.']);
});

test('form mode: a JSON answer that stops before it is complete is not taken', () => {
  expect(isTruncatedJson('{"ops":[{"op":"add","type":"TextBox"},{"op":"add"')).toBe(true);
  expect(isTruncatedJson('{"ops":[{"op":"add","type":"Text')).toBe(true);
  expect(isTruncatedJson('{"ops":[]} and some words {')).toBe(false);
  expect(isTruncatedJson('{"code":"a } b"}')).toBe(false);
  const r = parseFormOps('{"ops":[{"op":"add","type":"TextBox","name":"t1"},{"op":"add","type":"CommandButton","name":"c1"}', newForm('Form1'));
  expect(r.ok).toBe(false);
  expect(!r.ok && r.reason).toMatch(/stops before it is complete/);
});

test('the form schema bounds numbers and names (no runaway inside the grammar); text keeps its escapes', () => {
  const json = JSON.stringify(FORM_OPS_SCHEMA);
  const add = (FORM_OPS_SCHEMA.properties.ops.items.anyOf[0] as { properties: Record<string, any> }).properties;
  expect(add.name).toEqual({ type: 'string', maxLength: 64 });
  expect(add.index).toEqual({ type: 'integer', minimum: 0, maximum: 32767 });
  expect(add.place.properties.gap).toEqual({ type: 'integer', minimum: 0, maximum: 100000 });
  // no maxLength where escapes are needed: xgrammar then allows none (code lost its \n live)
  expect(FORM_OPS_SCHEMA.properties.code).toEqual({ type: 'string' });
  expect(json).toContain('"anyOf":[{"type":"string"},{"type":"number"');
  expect(json).toContain('"type":"number","minimum":-2147483648,"maximum":4294967295');
  // every number of the schema has its bound
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o.type === 'integer' || o.type === 'number') expect(o.maximum).toBeTypeOf('number');
    Object.values(o).forEach(walk);
  };
  walk(FORM_OPS_SCHEMA);
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Small overflows: the form grows instead of a model round

test('growForOverflow: up to 240 twips past the right or bottom edge grows the form with a margin; more does not', () => {
  const f = newForm('Form1');
  f.props.Width = 4800; f.props.Height = 3600;   // client 4680 x 3210
  add(f, 'CommandButton', 'cmdOK', { Left: 3600, Top: 2940, Width: 1215, Height: 375 });   // 135 past the right, 105 past the bottom
  expect(growForOverflow(f)).toEqual({ props: { Width: 5175, Height: 3945 }, note: 'Made the form 375 twips wider so that cmdOK fits and 345 twips higher so that cmdOK fits.' });
  f.controls[0].props.Left = 4000;   // 535 past: a model round
  expect(growForOverflow(f)?.props).toEqual({ Height: 3945 });
  f.controls[0].props.Top = 120;
  expect(growForOverflow(f)).toBeNull();
  // only the controls the answer touched count
  f.controls[0].props.Left = 3600;
  expect(growForOverflow(f, new Set(['cmdcancel']))).toBeNull();
  expect(growForOverflow(f, new Set(['cmdok']))?.props).toEqual({ Width: 5175 });
});

test('form mode: a small overflow is fixed without a check round', async () => {
  const s = ide('designer');
  const reply = JSON.stringify({ ops: [{ op: 'form', props: { Width: 4800, Height: 3600 } }, { op: 'add', type: 'CommandButton', name: 'cmdOK', props: { Caption: 'Go', Left: 3600, Top: 240, Width: 1215, Height: 375 } }] });
  const b = fakeBackend([reply]);
  const p = askAi(s, b, { codeWindowFor: () => null });
  await enterPrompt('add OK');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat).toHaveBeenCalledTimes(1);
  expect(text()).toContain('Made the form 375 twips wider so that cmdOK fits.');
  expect([...document.querySelectorAll('.ai-op')].map(e => e.textContent)).toEqual(['Set Form.Height = 3600', 'Add CommandButton cmdOK', 'Set Form.Width = 5175']);
  click('OK');
  await p;
  expect(s.project.forms[0].props.Width).toBe(5175);
});

test('the form prompt says a Left/Top in props wins over "place", and Form enums carry their values', () => {
  const proj = newProject();
  const sys = buildFormRequest(proj, proj.forms[0].id, 'x')[0].content;
  expect(sys).toContain('With "place", leave Left and Top out of "props"');
  expect(sys).toContain('StartUpPosition(0 Manual,1 CenterOwner,2 CenterScreen,3 Windows Default)');
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Card idioms

test('the language card has the idioms the live runs missed, within its budget', () => {
  for (const t of ['ListView1.ListItems.Add(, , "Ann"): it.SubItems(1)', 'ListItems(1) is the first', 'TabStrip1.SelectedItem.Index',
    'Scale (x1, y1)-(x2, y2)', 'WindowList only on a top-level menu, set at design time', 'Data1.Refresh']) expect(LANGUAGE_REFERENCE).toContain(t);
  expect(LANGUAGE_REFERENCE.length / 3.5).toBeLessThanOrEqual(2000);
});
